import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      seed INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'   -- active | finished | abandoned | rejected
    );
    CREATE INDEX IF NOT EXISTS sessions_wallet ON sessions(wallet, started_at);

    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      wallet TEXT NOT NULL,
      period TEXT NOT NULL,
      score INTEGER NOT NULL,
      eaten INTEGER NOT NULL,
      ticks INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scores_period ON scores(period, score DESC);

  `);
  return db;
}

// Best score per wallet for a period; ties go to whoever got there first.
export function leaderboard(db, period, limit = 50) {
  return db
    .prepare(
      `SELECT s.wallet, s.score, MIN(s.created_at) AS achieved_at
         FROM scores s
         JOIN (SELECT wallet, MAX(score) AS best FROM scores WHERE period = ? AND score > 0 GROUP BY wallet) b
           ON b.wallet = s.wallet AND b.best = s.score
        WHERE s.period = ?
        GROUP BY s.wallet
        ORDER BY s.score DESC, achieved_at ASC
        LIMIT ?`
    )
    .all(period, period, limit)
    .map((r, i) => ({ rank: i + 1, wallet: r.wallet, score: r.score, achievedAt: r.achieved_at }));
}
