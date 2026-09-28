import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config, assertConfig, periodKey, periodEndsAt, previousPeriodKey, PERIOD_RE, ROOT } from "./config.js";
import { openDb, leaderboard } from "./db.js";
import { isValidAddress, verifyWalletSignature, checkHolder, rpc, getTokenBalance } from "./solana.js";
import { replay } from "../shared/engine.js";

const SESSION_TTL_MS = 3 * 60 * 60 * 1000; // a single game may last at most 3h
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NONCE_TTL_MS = 5 * 60 * 1000;
const MAX_BODY = 1024 * 1024;

// ---------- auth tokens (HMAC-signed, stateless) ----------
function signToken(secret, wallet) {
  const payload = Buffer.from(JSON.stringify({ w: wallet, exp: Date.now() + TOKEN_TTL_MS })).toString("base64url");
  const mac = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}
function readToken(secret, token) {
  if (typeof token !== "string") return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { w, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return exp > Date.now() && isValidAddress(w) ? w : null;
  } catch {
    return null;
  }
}

// ---------- tiny fixed-window rate limiter ----------
function rateLimiter() {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, 60_000).unref();
  return (key, max, windowMs) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) {
      hits.set(key, { n: 1, reset: now + windowMs });
      return true;
    }
    h.n++;
    return h.n <= max;
  };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

export function createApp(cfg, db, deps = {}) {
  const holderCheck = deps.checkHolder || ((w) => checkHolder({ rpcUrl: cfg.rpcUrl, mint: cfg.tokenMint, minHold: cfg.minHold, skip: cfg.skipHolderCheck }, w));
  const nonces = new Map();
  const vaultCache = { at: 0, value: null };
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of nonces) if (v.exp < now) nonces.delete(k);
  }, 60_000).unref();
  const allow = rateLimiter();
  const staticRoots = { "/shared/": path.join(ROOT, "shared"), "/": path.join(ROOT, "public") };

  const q = {
    abandon: db.prepare("UPDATE sessions SET status='abandoned' WHERE wallet=? AND status='active'"),
    insertSession: db.prepare("INSERT INTO sessions (id, wallet, seed, started_at) VALUES (?,?,?,?)"),
    getSession: db.prepare("SELECT * FROM sessions WHERE id=?"),
    setStatus: db.prepare("UPDATE sessions SET status=? WHERE id=? AND status='active'"),
    insertScore: db.prepare(
      "INSERT INTO scores (session_id, wallet, period, score, eaten, ticks, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?)"
    ),
    best: db.prepare("SELECT MAX(score) AS best FROM scores WHERE wallet=? AND period=?"),
    recentRounds: db.prepare("SELECT DISTINCT period FROM scores WHERE period >= ? AND period < ? ORDER BY period DESC"),
  };

  function clientIp(req) {
    if (cfg.trustProxy) {
      const fwd = req.headers["x-forwarded-for"];
      if (fwd) return String(fwd).split(",")[0].trim();
    }
    return req.socket.remoteAddress || "?";
  }

  async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw new HttpError(413, "Body too large");
      chunks.push(c);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      throw new HttpError(400, "Invalid JSON");
    }
  }

  function requireWallet(req) {
    const h = req.headers.authorization || "";
    const wallet = readToken(cfg.sessionSecret, h.startsWith("Bearer ") ? h.slice(7) : "");
    if (!wallet) throw new HttpError(401, "Sign in with your wallet first");
    return wallet;
  }

  function rankOf(period, wallet) {
    const idx = leaderboard(db, period, 100000).findIndex((r) => r.wallet === wallet);
    return idx === -1 ? null : idx + 1;
  }

  const routes = {
    "GET /api/config": () => ({
      tokenSymbol: cfg.tokenSymbol,
      tokenMint: cfg.tokenMint,
      minHold: cfg.minHold,
      stonkfunUrl: cfg.stonkfunUrl,
      prizeSplits: cfg.prizeSplits,
      period: periodKey(),
      periodEndsAt: periodEndsAt(),
      previousPeriod: previousPeriodKey(),
      roundLength: "hour",
      vaultAddress: cfg.vaultAddress || null,
      holderCheck: !cfg.skipHolderCheck,
    }),

    "GET /api/leaderboard": (req, url) => {
      const period = url.searchParams.get("period") || periodKey();
      if (!PERIOD_RE.test(period)) throw new HttpError(400, "Bad period");
      return { period, entries: leaderboard(db, period, 25) };
    },

    // Prize vault: the wallet you fund by hand. Shows its live balances.
    "GET /api/vault": async () => {
      if (!cfg.vaultAddress) return { address: null };
      const hit = vaultCache.value && Date.now() - vaultCache.at < 60_000;
      if (!hit) {
        try {
          const lamports = (await rpc(cfg.rpcUrl, "getBalance", [cfg.vaultAddress])).value;
          let token = null;
          if (cfg.tokenMint) token = (await getTokenBalance(cfg.rpcUrl, cfg.vaultAddress, cfg.tokenMint)).ui;
          vaultCache.value = { address: cfg.vaultAddress, sol: lamports / 1e9, token };
          vaultCache.at = Date.now();
        } catch {
          return vaultCache.value || { address: cfg.vaultAddress, sol: null, token: null };
        }
      }
      return vaultCache.value;
    },

    // Winners of the last 24 finished rounds — the list you pay from.
    // For the most recent round we also check whether each winner still holds.
    "GET /api/rounds": async () => {
      const since = periodKey(new Date(Date.now() - 24 * 3600_000));
      const periods = q.recentRounds.all(since, periodKey()).map((r) => r.period);
      const places = Math.max(1, cfg.prizeSplits.length);
      const rounds = periods
        .map((period) => ({ period, winners: leaderboard(db, period, places) }))
        .filter((r) => r.winners.length);
      if (rounds[0]) {
        await Promise.all(
          rounds[0].winners.map(async (w) => {
            try {
              w.holdsNow = (await holderCheck(w.wallet)).eligible;
            } catch {
              w.holdsNow = null;
            }
          })
        );
      }
      return { rounds };
    },

    "GET /api/auth/nonce": (req, url) => {
      const wallet = url.searchParams.get("wallet");
      if (!isValidAddress(wallet)) throw new HttpError(400, "Invalid wallet address");
      if (!allow(`nonce:${clientIp(req)}`, 30, 60_000)) throw new HttpError(429, "Slow down");
      const nonce = crypto.randomBytes(16).toString("hex");
      const message =
        `Sign in to Nokia Snake (${cfg.tokenSymbol})\n\n` +
        `This only proves you own this wallet. It costs nothing and sends no transaction.\n\n` +
        `Wallet: ${wallet}\nNonce: ${nonce}\nIssued: ${new Date().toISOString()}`;
      nonces.set(nonce, { wallet, message, exp: Date.now() + NONCE_TTL_MS });
      return { nonce, message };
    },

    "POST /api/auth/verify": async (req) => {
      const { wallet, nonce, signature } = await readJson(req);
      const n = nonces.get(nonce);
      nonces.delete(nonce); // single use
      if (!n || n.exp < Date.now() || n.wallet !== wallet) throw new HttpError(400, "Sign-in expired, try again");
      if (!verifyWalletSignature(wallet, n.message, signature)) throw new HttpError(401, "Signature check failed");
      return { token: signToken(cfg.sessionSecret, wallet), wallet };
    },

    "GET /api/me": async (req) => {
      const wallet = requireWallet(req);
      const period = periodKey();
      let holder;
      try {
        holder = await holderCheck(wallet);
      } catch (e) {
        holder = { eligible: false, balance: null, error: "Could not check balance right now" };
      }
      return { wallet, ...holder, minHold: cfg.minHold, best: q.best.get(wallet, period).best ?? 0, rank: rankOf(period, wallet) };
    },

    "POST /api/game/start": async (req) => {
      const wallet = requireWallet(req);
      if (!allow(`start:${wallet}`, 40, 10 * 60_000)) throw new HttpError(429, "Too many games, take a breather");
      let holder;
      try {
        holder = await holderCheck(wallet);
      } catch {
        throw new HttpError(503, "Could not check your token balance, try again");
      }
      if (!holder.eligible)
        throw new HttpError(403, `Hold at least ${cfg.minHold.toLocaleString()} ${cfg.tokenSymbol} to play ranked`);
      q.abandon.run(wallet); // one live ranked game per wallet
      const id = crypto.randomUUID();
      const seed = crypto.randomInt(0, 2 ** 32 - 1);
      q.insertSession.run(id, wallet, seed, Date.now());
      return { sessionId: id, seed };
    },

    "POST /api/game/finish": async (req) => {
      const wallet = requireWallet(req);
      const { sessionId, inputs } = await readJson(req);
      const s = typeof sessionId === "string" ? q.getSession.get(sessionId) : null;
      if (!s || s.wallet !== wallet) throw new HttpError(404, "Unknown game");
      if (s.status !== "active") throw new HttpError(409, "This game was already submitted or replaced by a newer one");

      const elapsed = Date.now() - s.started_at;
      const result = replay(s.seed, inputs);
      const reject = (msg) => {
        q.setStatus.run("rejected", s.id);
        throw new HttpError(422, msg);
      };
      if (!result) reject("Game log failed verification");
      if (elapsed > SESSION_TTL_MS) reject("Game session expired");
      // The game can't be played faster than its own tick clock allows.
      if (elapsed < result.minDurationMs * 0.95 - 1000) reject("Game finished faster than possible");

      // Atomic claim of the session so a double-submit can't record twice.
      const claimed = q.setStatus.run("finished", s.id);
      if (claimed.changes !== 1) throw new HttpError(409, "Already submitted");

      const period = periodKey();
      q.insertScore.run(s.id, wallet, period, result.score, result.eaten, result.ticks, elapsed, Date.now());
      return {
        score: result.score,
        eaten: result.eaten,
        best: q.best.get(wallet, period).best,
        rank: rankOf(period, wallet),
        period,
      };
    },
  };

  function serveStatic(req, res, pathname) {
    const prefix = pathname.startsWith("/shared/") ? "/shared/" : "/";
    const root = staticRoots[prefix];
    let rel = decodeURIComponent(pathname.slice(prefix.length)) || "index.html";
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep)) return false;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    fs.createReadStream(file).pipe(res);
    return true;
  }

  const securityHeaders = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  };

  return async function handler(req, res) {
    for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);
    const url = new URL(req.url, "http://localhost");
    const route = routes[`${req.method} ${url.pathname}`];
    try {
      if (route) {
        const data = await route(req, url);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(data));
        return;
      }
      if (req.method === "GET" && !url.pathname.startsWith("/api/") && serveStatic(req, res, url.pathname)) return;
      throw new HttpError(404, "Not found");
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: status === 500 ? "Server error" : e.message }));
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assertConfig();
  const db = openDb(config.dbPath);
  const server = http.createServer(createApp(config, db));
  server.listen(config.port, () => {
    console.log(`Nokia Snake running on http://localhost:${config.port}`);
    if (config.skipHolderCheck) console.warn("⚠ DEV_SKIP_HOLDER_CHECK is on — anyone can play ranked.");
  });
}
