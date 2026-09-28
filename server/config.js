import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const bool = (v) => String(v).toLowerCase() === "true";

export const config = {
  port: Number(env.PORT || 3000),
  production: env.NODE_ENV === "production",
  sessionSecret: env.SESSION_SECRET || "",
  rpcUrl: env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  tokenMint: env.TOKEN_MINT || "",
  tokenSymbol: env.TOKEN_SYMBOL || "SNAKE",
  stonkfunUrl: env.STONKFUN_URL || "https://www.stonkfun.xyz",
  minHold: Number(env.MIN_HOLD || 0),
  dbPath: path.resolve(ROOT, env.DB_PATH || "data/snake.db"),
  trustProxy: bool(env.TRUST_PROXY),
  skipHolderCheck: bool(env.DEV_SKIP_HOLDER_CHECK),
  vaultAddress: (env.VAULT_ADDRESS || "").trim(),
  prizeSplits: (env.PRIZE_SPLITS || env.PAYOUT_SPLITS || "50,30,20")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => n > 0),
};

export function assertConfig() {
  const problems = [];
  if (config.sessionSecret.length < 32)
    problems.push("SESSION_SECRET must be at least 32 characters");
  if (!config.skipHolderCheck && !config.tokenMint)
    problems.push("TOKEN_MINT is required (your StonkFun token's mint address)");
  if (config.vaultAddress && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(config.vaultAddress))
    problems.push("VAULT_ADDRESS doesn't look like a Solana address");
  if (config.production && config.skipHolderCheck)
    problems.push("DEV_SKIP_HOLDER_CHECK cannot be used with NODE_ENV=production");
  if (problems.length) {
    console.error("Config errors:\n - " + problems.join("\n - "));
    process.exit(1);
  }
}

// Competition rounds are UTC clock hours, keyed like "2026-09-28T14"
// (= 14:00–15:00 UTC). Keys sort chronologically as plain strings.
const HOUR = 3600_000;
export const PERIOD_RE = /^\d{4}-\d{2}-\d{2}T\d{2}$/;

export function periodKey(date = new Date()) {
  return new Date(Math.floor(date.getTime() / HOUR) * HOUR).toISOString().slice(0, 13);
}

export function periodStart(key) {
  return new Date(`${key}:00:00.000Z`);
}

export function periodEndsAt(date = new Date()) {
  return new Date((Math.floor(date.getTime() / HOUR) + 1) * HOUR).toISOString();
}

export function previousPeriodKey(date = new Date()) {
  return periodKey(new Date(date.getTime() - HOUR));
}
