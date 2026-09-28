// Deterministic Nokia-style snake engine.
// The SAME file runs in the browser (for play) and on the server (to replay
// and verify every submitted score). Given a seed + the list of direction
// changes, the outcome is fully reproducible.

export const COLS = 20;
export const ROWS = 9;
export const POINTS_PER_FOOD = 10;

// Directions: 0=up 1=right 2=down 3=left
export const DIRS = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

// mulberry32 — tiny seeded PRNG. State kept on the game object.
function nextRandom(state) {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function createGame(seed) {
  const state = {
    rng: seed >>> 0,
    snake: [
      { x: 6, y: 4 },
      { x: 5, y: 4 },
      { x: 4, y: 4 },
      { x: 3, y: 4 },
    ],
    dir: 1,
    food: null,
    alive: true,
    won: false,
    tick: 0,
    eaten: 0,
  };
  placeFood(state);
  return state;
}

function placeFood(state) {
  const occupied = new Set(state.snake.map((p) => p.y * COLS + p.x));
  const free = [];
  for (let i = 0; i < COLS * ROWS; i++) if (!occupied.has(i)) free.push(i);
  if (free.length === 0) {
    state.food = null;
    state.alive = false;
    state.won = true;
    return;
  }
  const idx = free[Math.floor(nextRandom(state) * free.length)];
  state.food = { x: idx % COLS, y: Math.floor(idx / COLS) };
}

export function score(state) {
  return state.eaten * POINTS_PER_FOOD;
}

// Speed curve: starts at 170ms per move, 4ms faster per food, floor 70ms.
export function tickInterval(state) {
  return Math.max(70, 170 - state.eaten * 4);
}

// A turn is valid if it is a real change and not a 180° reversal.
export function isValidTurn(currentDir, newDir) {
  return (
    Number.isInteger(newDir) &&
    newDir >= 0 &&
    newDir <= 3 &&
    newDir !== currentDir &&
    (newDir + 2) % 4 !== currentDir
  );
}

// Advance one tick. newDir is optional (undefined = keep going).
// Returns "move" | "eat" | "dead" | "win".
export function step(state, newDir) {
  if (!state.alive) return "dead";
  if (newDir !== undefined && isValidTurn(state.dir, newDir)) state.dir = newDir;

  const head = state.snake[0];
  const d = DIRS[state.dir];
  const nx = head.x + d.x;
  const ny = head.y + d.y;
  state.tick++;

  if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) {
    state.alive = false;
    return "dead";
  }

  const eating = state.food && state.food.x === nx && state.food.y === ny;
  if (!eating) state.snake.pop(); // tail moves out of the way first

  for (const p of state.snake) {
    if (p.x === nx && p.y === ny) {
      state.alive = false;
      return "dead";
    }
  }

  state.snake.unshift({ x: nx, y: ny });
  if (eating) {
    state.eaten++;
    placeFood(state);
    return state.won ? "win" : "eat";
  }
  return "move";
}

// Server-side verification. inputs = [[tick, dir], ...] strictly increasing
// ticks, each a valid turn at that moment. Returns null if the log is
// malformed or tampered; otherwise the verified result.
export const MAX_TICKS = 100000;

export function replay(seed, inputs) {
  if (!Array.isArray(inputs) || inputs.length > MAX_TICKS) return null;
  const state = createGame(seed);
  let minDurationMs = 0;
  let i = 0;
  let lastTick = -1;

  while (state.alive) {
    if (state.tick >= MAX_TICKS) return null;
    let dir;
    if (i < inputs.length) {
      const entry = inputs[i];
      if (!Array.isArray(entry) || entry.length !== 2) return null;
      const [t, d] = entry;
      if (!Number.isInteger(t) || t <= lastTick) return null;
      if (t === state.tick) {
        if (!isValidTurn(state.dir, d)) return null;
        dir = d;
        lastTick = t;
        i++;
      }
    }
    minDurationMs += tickInterval(state);
    step(state, dir);
  }

  // Inputs recorded after the snake died = fabricated log.
  if (i !== inputs.length) return null;

  return {
    score: score(state),
    eaten: state.eaten,
    ticks: state.tick,
    won: state.won,
    minDurationMs,
  };
}
