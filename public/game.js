import { COLS, ROWS, createGame, step, tickInterval, score, isValidTurn } from "/shared/engine.js";

// ================= LCD rendering (84x48, 1-bit) =================
const canvas = document.getElementById("lcd");
const ctx = canvas.getContext("2d");
const LCD = "#c7f0d8";
const INK = "#43523d";
const BOARD_X = 2, BOARD_Y = 10, CELL = 4;

// 3x5 bitmap font
const FONT = {
  A:"010101111101101",B:"110101110101110",C:"011100100100011",D:"110101101101110",E:"111100110100111",
  F:"111100110100100",G:"011100101101011",H:"101101111101101",I:"111010010010111",J:"001001001101010",
  K:"101101110101101",L:"100100100100111",M:"101111101101101",N:"101111111111101",O:"010101101101010",
  P:"110101110100100",Q:"010101101110011",R:"110101110101101",S:"011100010001110",T:"111010010010010",
  U:"101101101101111",V:"101101101101010",W:"101101111111101",X:"101101010101101",Y:"101101010010010",
  Z:"111001010100111",0:"111101101101111",1:"010110010010111",2:"110001010100111",3:"110001010001110",
  4:"101101111001001",5:"111100110001110",6:"011100111101111",7:"111001010010010",8:"111101111101111",
  9:"111101111001110",":":"000010000010000",".":"000000000000010","-":"000000111000000",
  "#":"101111101111101","!":"010010010000010","/":"001001010100100","?":"110001010000010"," ":"000000000000000",
};

function clear() { ctx.fillStyle = LCD; ctx.fillRect(0, 0, 84, 48); ctx.fillStyle = INK; }
function px(x, y, w = 1, h = 1) { ctx.fillRect(x, y, w, h); }
function text(str, x, y, scale = 1) {
  str = String(str).toUpperCase();
  for (const ch of str) {
    const g = FONT[ch] || FONT["?"];
    for (let i = 0; i < 15; i++) if (g[i] === "1") px(x + (i % 3) * scale, y + Math.floor(i / 3) * scale, scale, scale);
    x += 4 * scale;
  }
}
function textWidth(str, scale = 1) { return String(str).length * 4 * scale - scale; }
function center(str, y, scale = 1) { text(str, Math.floor((84 - textWidth(str, scale)) / 2), y, scale); }

function drawBoard(state, { hideSnake = false } = {}) {
  clear();
  text(String(score(state)).padStart(4, "0"), 2, 2);
  const tag = mode === "ranked" ? "RANKED" : "PRACTICE";
  text(tag, 82 - textWidth(tag), 2);
  // border
  px(1, 9, 82, 1); px(1, 46, 82, 1); px(1, 9, 1, 38); px(82, 9, 1, 38);

  if (state.food) {
    const fx = BOARD_X + state.food.x * CELL, fy = BOARD_Y + state.food.y * CELL;
    px(fx + 1, fy, 1, 3); px(fx, fy + 1, 3, 1);
  }
  if (hideSnake) return;
  const s = state.snake;
  for (let i = 0; i < s.length; i++) {
    const x = BOARD_X + s[i].x * CELL, y = BOARD_Y + s[i].y * CELL;
    px(x, y, 3, 3);
    if (i > 0) { // connect to previous segment so the body reads as one line
      const dx = s[i - 1].x - s[i].x, dy = s[i - 1].y - s[i].y;
      if (dx === 1) px(x + 3, y, 1, 3);
      if (dx === -1) px(x - 1, y, 1, 3);
      if (dy === 1) px(x, y + 3, 3, 1);
      if (dy === -1) px(x, y - 1, 3, 1);
    }
  }
  // eye
  const h = s[0];
  ctx.fillStyle = LCD;
  px(BOARD_X + h.x * CELL + 1, BOARD_Y + h.y * CELL + 1);
  ctx.fillStyle = INK;
}

function drawMenu() {
  clear();
  center("SNAKE", 4, 2);
  // little snake doodle
  const doodle = [[20,20],[24,20],[28,20],[32,20],[32,24],[36,24],[40,24],[44,24],[48,24],[48,20],[52,20],[56,20]];
  for (const [x, y] of doodle) px(x, y, 3, 3);
  px(21, 21); px(63, 21, 1, 3); px(62, 22, 3, 1);
  center(mode === "ranked" ? "RANKED" : "PRACTICE", 30);
  center("5 OR ENTER: START", 38);
}

function drawOver() {
  clear();
  center("GAME OVER", 3);
  center("SCORE " + String(lastResult.score).padStart(4, "0"), 13);
  let line = "";
  if (mode !== "ranked" && !lastResult.ranked) line = "PRACTICE";
  else if (submit.state === "saving") line = "SAVING...";
  else if (submit.state === "saved") line = submit.rank ? `RANK #${submit.rank}` : "SAVED";
  else if (submit.state === "error") line = "NOT SAVED";
  center(line, 23);
  if (submit.state === "saved" && submit.best) center(`BEST ${submit.best}`, 31);
  center("5: AGAIN", 40);
}

function drawPaused() {
  drawBoard(game);
  ctx.fillStyle = LCD; ctx.fillRect(20, 20, 44, 13); ctx.fillStyle = INK;
  px(20, 20, 44, 1); px(20, 32, 44, 1); px(20, 20, 1, 13); px(63, 20, 1, 13);
  center("PAUSED", 24);
}

// ================= sound =================
let soundOn = true, audio;
function beep(freq = 880, ms = 40) {
  if (!soundOn) return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = "square"; o.frequency.value = freq; g.gain.value = 0.04;
    o.connect(g).connect(audio.destination);
    o.start(); o.stop(audio.currentTime + ms / 1000);
  } catch {}
}

// ================= game state machine =================
let screen = "menu"; // menu | starting | playing | paused | dying | over
let mode = "practice";
let game = null, session = null, inputs = [], queue = [], timer = null;
let lastResult = { score: 0 };
let submit = { state: "idle" };

async function startGame() {
  if (screen === "starting") return;
  clearTimeout(timer);
  queue = []; inputs = []; session = null;
  let seed = (Math.random() * 2 ** 32) >>> 0;
  if (mode === "ranked") {
    screen = "starting";
    clear(); center("STARTING...", 21);
    try {
      session = await api("POST", "/api/game/start");
      seed = session.seed;
    } catch (e) {
      setMsg(e.message, true);
      if (e.status === 401 || e.status === 403) await refreshMe();
      screen = "menu"; drawMenu();
      return;
    }
  }
  game = createGame(seed);
  screen = "playing";
  drawBoard(game);
  timer = setTimeout(tick, tickInterval(game));
}

function tick() {
  if (screen !== "playing") return;
  let dir;
  while (queue.length) {
    const d = queue.shift();
    if (isValidTurn(game.dir, d)) { dir = d; break; }
  }
  if (dir !== undefined) inputs.push([game.tick, dir]);
  const ev = step(game, dir);
  if (ev === "eat") beep(1320, 30);
  if (ev === "dead" || ev === "win") return die();
  drawBoard(game);
  timer = setTimeout(tick, tickInterval(game));
}

function die() {
  screen = "dying";
  beep(220, 300);
  lastResult = { score: score(game), ranked: !!session };
  if (session) submitScore(session.sessionId, inputs.slice());
  else submit = { state: "idle" };
  let blinks = 0;
  const blink = () => {
    drawBoard(game, { hideSnake: blinks % 2 === 0 });
    if (++blinks < 6) timer = setTimeout(blink, 180);
    else { screen = "over"; drawOver(); }
  };
  blink();
}

async function submitScore(sessionId, log) {
  submit = { state: "saving" };
  try {
    const r = await api("POST", "/api/game/finish", { sessionId, inputs: log });
    submit = { state: "saved", rank: r.rank, best: r.best };
    loadBoard();
    refreshMe();
  } catch (e) {
    submit = { state: "error" };
    setMsg(e.message, true);
  }
  if (screen === "over") drawOver();
}

function togglePause() {
  if (screen === "playing") { screen = "paused"; clearTimeout(timer); drawPaused(); }
  else if (screen === "paused") { screen = "playing"; drawBoard(game); timer = setTimeout(tick, tickInterval(game)); }
}

// ================= input =================
function press(key) {
  const dirMap = { 2: 0, 6: 1, 8: 2, 4: 3 };
  if (key in dirMap) {
    if (screen === "playing") {
      const d = dirMap[key];
      const last = queue.length ? queue[queue.length - 1] : game.dir;
      if (queue.length < 2 && isValidTurn(last, d)) queue.push(d);
    }
    return;
  }
  if (key === "5") {
    if (screen === "menu" || screen === "over") startGame();
    else if (screen === "paused") togglePause();
  } else if (key === "0") togglePause();
  else if (key === "sound" || key === "*") { soundOn = !soundOn; beep(660, 60); }
  else if (key === "menu") {
    if (screen === "playing") togglePause();
    else if (screen === "over" || screen === "paused") { clearTimeout(timer); screen = "menu"; drawMenu(); }
  }
}

const KEYS = {
  ArrowUp: "2", KeyW: "2", ArrowLeft: "4", KeyA: "4", ArrowRight: "6", KeyD: "6", ArrowDown: "8", KeyS: "8",
  Enter: "5", Space: "5", KeyP: "0", Escape: "menu", KeyM: "sound",
  Digit2: "2", Digit4: "4", Digit5: "5", Digit6: "6", Digit8: "8", Digit0: "0",
  Numpad2: "2", Numpad4: "4", Numpad5: "5", Numpad6: "6", Numpad8: "8", Numpad0: "0",
};
window.addEventListener("keydown", (e) => {
  if (e.target.closest && e.target.closest("input, textarea, summary")) return;
  const k = KEYS[e.code];
  if (!k) return;
  e.preventDefault();
  if (e.repeat && !"2468".includes(k)) return;
  press(k);
  const btn = document.querySelector(`.keypad [data-key="${k}"]`);
  if (btn) { btn.classList.add("down"); setTimeout(() => btn.classList.remove("down"), 90); }
});
document.querySelectorAll("[data-key]").forEach((b) =>
  b.addEventListener("pointerdown", (e) => { e.preventDefault(); press(b.dataset.key); })
);

// swipe on the screen
let touchStart = null;
canvas.addEventListener("pointerdown", (e) => { touchStart = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener("pointerup", (e) => {
  if (!touchStart) return;
  const dx = e.clientX - touchStart.x, dy = e.clientY - touchStart.y;
  touchStart = null;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 18) return press(screen === "playing" ? "0" : "5");
  press(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "6" : "4") : (dy > 0 ? "8" : "2"));
});
window.addEventListener("blur", () => { if (screen === "playing") togglePause(); });
document.addEventListener("visibilitychange", () => { if (document.hidden && screen === "playing") togglePause(); });

// ================= API + wallet =================
const $ = (id) => document.getElementById(id);
let cfg = null, token = null, me = null;

function store(k, v) { try { v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
function load(k) { try { return localStorage.getItem(k); } catch { return null; } }

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) { token = null; store("snake_token"); }
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function setMsg(m, err = false) { const el = $("wallet-msg"); el.textContent = m || ""; el.classList.toggle("err", err); }
const short = (w) => `${w.slice(0, 4)}…${w.slice(-4)}`;
const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });

function getProvider() {
  return window.phantom?.solana || window.solflare || window.backpack?.solana || window.solana || null;
}

async function connect() {
  const provider = getProvider();
  if (!provider) {
    const link = `https://phantom.app/ul/browse/${encodeURIComponent(location.href)}?ref=${encodeURIComponent(location.origin)}`;
    setMsg("");
    $("wallet-msg").innerHTML = `No Solana wallet found. Install <a href="https://phantom.app" target="_blank" rel="noopener">Phantom</a> or <a href="https://solflare.com" target="_blank" rel="noopener">Solflare</a> — on mobile, <a href="${link}">open this page in Phantom</a>.`;
    return;
  }
  try {
    setMsg("Approve the connection in your wallet…");
    const res = await provider.connect();
    const wallet = (res?.publicKey || provider.publicKey).toString();
    const { nonce, message } = await api("GET", `/api/auth/nonce?wallet=${wallet}`);
    setMsg("Sign the message to prove it's your wallet (free, no transaction)…");
    const signed = await provider.signMessage(new TextEncoder().encode(message), "utf8");
    const sigBytes = signed?.signature || signed;
    const signature = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));
    const r = await api("POST", "/api/auth/verify", { wallet, nonce, signature });
    token = r.token;
    store("snake_token", token);
    setMsg("");
    await refreshMe();
  } catch (e) {
    setMsg(e?.message || "Wallet connection cancelled", true);
  }
}

function disconnect() {
  token = null; me = null; store("snake_token");
  try { getProvider()?.disconnect?.(); } catch {}
  renderWallet();
}

async function refreshMe() {
  if (!token) return renderWallet();
  try { me = await api("GET", "/api/me"); }
  catch { me = null; }
  renderWallet();
}

function renderWallet() {
  const sym = `$${cfg.tokenSymbol}`;
  if (me) {
    $("wallet-status").textContent = short(me.wallet);
    $("holder-row").classList.remove("hidden");
    $("holding").textContent = me.skipped ? "check disabled (dev)" : me.balance == null ? "unknown" : `${fmt(me.balance)} ${sym}`;
    $("connect").textContent = "Disconnect";
    if (!me.eligible && !me.error) setMsg(`Hold at least ${fmt(cfg.minHold)} ${sym} to play ranked. You can still play practice.`);
    if (me.error) setMsg(me.error, true);
  } else {
    $("wallet-status").textContent = "Not connected";
    $("holder-row").classList.add("hidden");
    $("connect").textContent = "Connect wallet";
  }
  const newMode = me?.eligible ? "ranked" : "practice";
  if (newMode !== mode) { mode = newMode; if (screen === "menu") drawMenu(); }
  $("mode").textContent = mode === "ranked" ? "Ranked" : "Practice";
  $("mode").classList.toggle("ranked", mode === "ranked");
  $("me-line").textContent = me && me.best ? `Your best this hour: ${me.best}${me.rank ? ` (#${me.rank})` : ""}` : "";
  loadBoard();
}

async function loadBoard() {
  try {
    const { entries } = await api("GET", "/api/leaderboard");
    const board = $("board");
    board.innerHTML = "";
    if (!entries.length) { board.innerHTML = `<li class="muted">No scores yet — be first.</li>`; return; }
    for (const e of entries) {
      const li = document.createElement("li");
      if (e.rank <= cfg.prizeSplits.length) li.classList.add("prize");
      if (me && e.wallet === me.wallet) li.classList.add("me");
      li.innerHTML = `<span class="r">#${e.rank}</span><span class="w"></span><span class="s">${e.score}</span>`;
      li.querySelector(".w").textContent = short(e.wallet);
      li.querySelector(".w").title = e.wallet;
      board.appendChild(li);
    }
  } catch {}
}

let rolling = false;
async function tickCountdown() {
  const ms = new Date(cfg.periodEndsAt) - Date.now();
  const el = $("countdown");
  if (ms <= 0) {
    el.textContent = "New round…";
    if (rolling) return;
    rolling = true; // new round: fetch the new end time and a fresh (empty) board
    try { Object.assign(cfg, await api("GET", "/api/config")); } catch {}
    rolling = false;
    loadBoard(); refreshMe();
    loadRounds(); loadVault();
    return;
  }
  const m = Math.floor(ms / 6e4), s = Math.floor(ms / 1000) % 60;
  el.textContent = `${m}:${String(s).padStart(2, "0")} left`;
  el.classList.toggle("soon", ms < 5 * 6e4);
}

async function loadVault() {
  if (!cfg.vaultAddress) return;
  try {
    const v = await api("GET", "/api/vault");
    $("vault-card").classList.remove("hidden");
    $("vault-addr").textContent = v.address;
    $("vault-link").href = `https://solscan.io/account/${v.address}`;
    const parts = [];
    if (v.sol != null) parts.push(`${fmt(v.sol)} SOL`);
    if (v.token != null && v.token > 0) parts.push(`${fmt(v.token)} $${cfg.tokenSymbol}`);
    $("vault-bal").textContent = parts.join(" + ") || "—";
  } catch {}
}

async function loadRounds() {
  try {
    const { rounds } = await api("GET", "/api/rounds");
    const box = $("rounds");
    if (!rounds.length) return;
    box.innerHTML = "";
    rounds.forEach((r, idx) => {
      const div = document.createElement("div");
      div.className = "round";
      const start = new Date(`${r.period}:00:00Z`);
      const end = new Date(start.getTime() + 3600_000);
      const t = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const day = start.toLocaleDateString([], { month: "short", day: "numeric" });
      div.innerHTML = `<h3></h3>`;
      div.querySelector("h3").textContent = `${day}, ${t(start)} – ${t(end)}${idx === 0 ? " · latest" : ""}`;
      for (const w of r.winners) {
        const row = document.createElement("div");
        row.className = "w-row";
        const id = `w-${r.period}-${w.rank}`;
        row.innerHTML = `<span class="place"></span><code></code><span class="sc"></span><button class="copy">Copy</button>`;
        row.querySelector(".place").textContent = `#${w.rank}`;
        const code = row.querySelector("code");
        code.textContent = w.wallet; code.id = id; code.title = w.wallet;
        row.querySelector(".sc").textContent = w.score;
        row.querySelector(".copy").dataset.copyTarget = id;
        if (w.holdsNow !== undefined && w.holdsNow !== null) {
          const h = document.createElement("span");
          h.className = `hold ${w.holdsNow ? "yes" : "no"}`;
          h.textContent = w.holdsNow ? "holds" : "sold";
          h.title = w.holdsNow ? "Still holds the minimum right now" : "No longer holds the minimum";
          row.querySelector(".sc").after(h);
          row.style.gridTemplateColumns = "26px minmax(0,1fr) auto auto auto";
        }
        div.appendChild(row);
      }
      box.appendChild(div);
    });
  } catch {}
}

// Copy buttons (vault address, winner wallets)
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-copy-target]");
  if (!btn) return;
  const text = document.getElementById(btn.dataset.copyTarget)?.textContent || "";
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch {}
    ta.remove();
  }
  btn.textContent = "Copied"; btn.classList.add("done");
  setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("done"); }, 1200);
});

async function init() {
  drawMenu();
  cfg = await api("GET", "/api/config");
  const sym = `$${cfg.tokenSymbol}`;
  $("sym").textContent = sym;
  document.querySelectorAll(".sym2").forEach((e) => (e.textContent = sym));
  $("min-hold").textContent = fmt(cfg.minHold);
  $("buy").href = cfg.stonkfunUrl;
  $("prizes").textContent = "Each hour's prize split: " + cfg.prizeSplits.map((p, i) => `#${i + 1} ${p}%`).join(" · ");
  $("connect").addEventListener("click", () => (me ? disconnect() : connect()));
  tickCountdown(); setInterval(tickCountdown, 1000);
  setInterval(loadBoard, 20_000);
  loadVault(); setInterval(loadVault, 2 * 60_000);
  loadRounds(); setInterval(loadRounds, 5 * 60_000);
  token = load("snake_token");
  await refreshMe();
}
init().catch((e) => setMsg("Could not reach the game server.", true));
