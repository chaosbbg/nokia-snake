// Minimal Solana helpers with zero dependencies:
//  - base58 decode (wallet addresses)
//  - ed25519 signature verification (wallet sign-in)
//  - holder balance lookup over JSON-RPC

import crypto from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAP = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function base58Decode(str) {
  if (typeof str !== "string" || str.length === 0 || str.length > 128) return null;
  let n = 0n;
  for (const c of str) {
    const v = MAP.get(c);
    if (v === undefined) return null;
    n = n * 58n + v;
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of str) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function isValidAddress(str) {
  const b = base58Decode(str);
  return !!b && b.length === 32;
}

export function verifyWalletSignature(wallet, message, signatureB64) {
  try {
    const pub = base58Decode(wallet);
    if (!pub || pub.length !== 32) return false;
    const sig = Buffer.from(signatureB64, "base64");
    if (sig.length !== 64) return false;
    const key = crypto.createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: pub.toString("base64url") },
      format: "jwk",
    });
    return crypto.verify(null, Buffer.from(message, "utf8"), key, sig);
  } catch {
    return false;
  }
}

export async function rpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${json.error.code}: ${json.error.message}`);
  return json.result;
}

// Sums every token account the wallet owns for this mint. Works for both the
// classic SPL Token program and Token-2022 (StonkFun v3 tax tokens).
export async function getTokenBalance(rpcUrl, wallet, mint) {
  const result = await rpc(rpcUrl, "getTokenAccountsByOwner", [
    wallet,
    { mint },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);
  let raw = 0n;
  let decimals = 0;
  for (const acc of result.value) {
    const amt = acc.account.data.parsed.info.tokenAmount;
    raw += BigInt(amt.amount);
    decimals = amt.decimals;
  }
  return { raw, decimals, ui: Number(raw) / 10 ** decimals };
}

// Cached holder check so the RPC isn't hammered on every game start.
const cache = new Map();
const CACHE_MS = 60_000;

export async function checkHolder({ rpcUrl, mint, minHold, skip }, wallet) {
  if (skip) return { eligible: true, balance: null, skipped: true };
  const hit = cache.get(wallet);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const bal = await getTokenBalance(rpcUrl, wallet, mint);
  const value = { eligible: bal.ui >= minHold && bal.raw > 0n, balance: bal.ui };
  cache.set(wallet, { at: Date.now(), value });
  return value;
}
