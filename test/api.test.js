import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { createApp } from "../server/index.js";
import { periodKey, periodEndsAt, previousPeriodKey } from "../server/config.js";
import { openDb } from "../server/db.js";
import { base58Encode } from "../server/solana.js";
import { createGame, step, isValidTurn, DIRS, COLS, ROWS, replay } from "../shared/engine.js";

// ---- a greedy bot that plays a real game and records its inputs ----
function playBot(seed, maxTicks = 3000) {
  const g = createGame(seed);
  const inputs = [];
  while (g.alive && g.tick < maxTicks) {
    const head = g.snake[0];
    const body = new Set(g.snake.slice(0, -1).map((p) => `${p.x},${p.y}`));
    const safe = [0, 1, 2, 3].filter((d) => {
      if ((d + 2) % 4 === g.dir) return false;
      const nx = head.x + DIRS[d].x, ny = head.y + DIRS[d].y;
      return nx >= 0 && ny >= 0 && nx < COLS && ny < ROWS && !body.has(`${nx},${ny}`);
    });
    const dist = (d) => Math.abs(head.x + DIRS[d].x - g.food.x) + Math.abs(head.y + DIRS[d].y - g.food.y);
    safe.sort((a, b) => dist(a) - dist(b));
    const d = safe.length ? safe[0] : g.dir;
    if (isValidTurn(g.dir, d)) inputs.push([g.tick, d]);
    step(g, isValidTurn(g.dir, d) ? d : undefined);
  }
  return { inputs, state: g };
}

function newWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  return { address: base58Encode(raw), sign: (msg) => crypto.sign(null, Buffer.from(msg), privateKey).toString("base64") };
}

async function setup(holders) {
  const db = openDb(":memory:");
  const cfg = { sessionSecret: "x".repeat(40), tokenSymbol: "SNAKE", minHold: 1000, prizeSplits: [50, 30, 20], stonkfunUrl: "", tokenMint: "", trustProxy: false };
  const app = createApp(cfg, db, { checkHolder: async (w) => ({ eligible: holders.has(w), balance: holders.has(w) ? 5000 : 0 }) });
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const login = async (w) => {
    const n = await call("GET", `/api/auth/nonce?wallet=${w.address}`);
    const v = await call("POST", "/api/auth/verify", { wallet: w.address, nonce: n.body.nonce, signature: w.sign(n.body.message) });
    return v.body.token;
  };
  // pretend the game started long enough ago to have been played for real
  const backdate = (id, ms) => db.prepare("UPDATE sessions SET started_at = started_at - ? WHERE id = ?").run(ms, id);
  return { db, server, call, login, backdate };
}

test("engine is deterministic and replay matches live play", () => {
  const { inputs, state } = playBot(12345);
  const r = replay(12345, inputs);
  assert.ok(r);
  assert.equal(r.eaten, state.eaten);
  assert.equal(r.ticks, state.tick);
  assert.ok(state.eaten > 3, `bot should eat something (ate ${state.eaten})`);
});

test("full ranked flow + anti-cheat", async (t) => {
  const alice = newWallet(), bob = newWallet(), mallory = newWallet();
  const { server, call, login, backdate } = await setup(new Set([alice.address, bob.address]));
  t.after(() => server.close());

  // bad signature is rejected
  const n = await call("GET", `/api/auth/nonce?wallet=${alice.address}`);
  const bad = await call("POST", "/api/auth/verify", { wallet: alice.address, nonce: n.body.nonce, signature: mallory.sign(n.body.message) });
  assert.equal(bad.status, 401);

  const aTok = await login(alice), bTok = await login(bob), mTok = await login(mallory);
  assert.ok(aTok && bTok && mTok);

  // no token → 401; non-holder → 403
  assert.equal((await call("POST", "/api/game/start")).status, 401);
  assert.equal((await call("POST", "/api/game/start", null, mTok)).status, 403);

  // alice plays a real game
  const s = (await call("POST", "/api/game/start", null, aTok)).body;
  const { inputs, state } = playBot(s.seed);
  // submitting instantly = faster than possible
  const tooFast = await call("POST", "/api/game/finish", { sessionId: s.sessionId, inputs }, aTok);
  assert.equal(tooFast.status, 422);

  const s2 = (await call("POST", "/api/game/start", null, aTok)).body;
  const play2 = playBot(s2.seed);
  backdate(s2.sessionId, replay(s2.seed, play2.inputs).minDurationMs + 2000);
  const ok = await call("POST", "/api/game/finish", { sessionId: s2.sessionId, inputs: play2.inputs }, aTok);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.score, play2.state.eaten * 10);
  assert.equal(ok.body.rank, 1);

  // double submit
  assert.equal((await call("POST", "/api/game/finish", { sessionId: s2.sessionId, inputs: play2.inputs }, aTok)).status, 409);

  // bob can't submit alice's session
  assert.equal((await call("POST", "/api/game/finish", { sessionId: s2.sessionId, inputs: play2.inputs }, bTok)).status, 404);

  // bob tampers: an illegal 180° turn
  const s3 = (await call("POST", "/api/game/start", null, bTok)).body;
  backdate(s3.sessionId, 10 * 60_000);
  const tampered = await call("POST", "/api/game/finish", { sessionId: s3.sessionId, inputs: [[0, 3]] }, bTok);
  assert.equal(tampered.status, 422);

  // bob fabricates inputs past his death
  const s4 = (await call("POST", "/api/game/start", null, bTok)).body;
  backdate(s4.sessionId, 10 * 60_000);
  const p4 = playBot(s4.seed);
  const fake = [...p4.inputs, [p4.state.tick + 5, 0]];
  assert.equal((await call("POST", "/api/game/finish", { sessionId: s4.sessionId, inputs: fake }, bTok)).status, 422);

  // starting a new game abandons the previous one
  const s5 = (await call("POST", "/api/game/start", null, bTok)).body;
  const s6 = (await call("POST", "/api/game/start", null, bTok)).body;
  backdate(s5.sessionId, 10 * 60_000);
  assert.equal((await call("POST", "/api/game/finish", { sessionId: s5.sessionId, inputs: playBot(s5.seed).inputs }, bTok)).status, 409);
  backdate(s6.sessionId, 10 * 60_000);
  const b6 = await call("POST", "/api/game/finish", { sessionId: s6.sessionId, inputs: playBot(s6.seed).inputs }, bTok);
  assert.equal(b6.status, 200);

  const board = (await call("GET", "/api/leaderboard")).body.entries;
  assert.equal(board.length, 2);
  assert.ok(board[0].score >= board[1].score);
  assert.deepEqual(new Set(board.map((e) => e.wallet)), new Set([alice.address, bob.address]));

  const me = await call("GET", "/api/me", null, aTok);
  assert.equal(me.body.eligible, true);
  assert.equal(me.body.best, play2.state.eaten * 10);
});

test("hourly round keys", () => {
  const d = new Date("2026-09-28T14:59:59.999Z");
  assert.equal(periodKey(d), "2026-09-28T14");
  assert.equal(periodEndsAt(d), "2026-09-28T15:00:00.000Z");
  assert.equal(previousPeriodKey(d), "2026-09-28T13");
  assert.equal(periodKey(new Date("2026-09-28T15:00:00.000Z")), "2026-09-28T15");
  assert.equal(previousPeriodKey(new Date("2026-01-01T00:10:00Z")), "2025-12-31T23");
  assert.ok("2026-09-28T09" < "2026-09-28T10"); // string order = time order
});

test("past rounds + vault endpoints", async (t) => {
  const alice = newWallet(), bob = newWallet();
  const { server, call, db } = await setup(new Set([alice.address]));
  t.after(() => server.close());
  const prev = previousPeriodKey();
  const ins = db.prepare("INSERT INTO scores (session_id,wallet,period,score,eaten,ticks,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?)");
  ins.run("a", alice.address, prev, 120, 12, 1, 1, 1);
  ins.run("b", bob.address, prev, 300, 30, 1, 1, 2);
  ins.run("c", alice.address, periodKey(), 999, 99, 1, 1, 3); // current hour: not listed
  const { rounds } = (await call("GET", "/api/rounds")).body;
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].period, prev);
  assert.deepEqual(rounds[0].winners.map((w) => [w.wallet, w.score, w.holdsNow]), [
    [bob.address, 300, false],
    [alice.address, 120, true],
  ]);
  assert.deepEqual((await call("GET", "/api/vault")).body, { address: null });
});
