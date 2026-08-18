#!/usr/bin/env node
/**
 * Import the Cursor session token from a local Cursor install into the account
 * file this service reads.
 *
 * Cursor keeps `cursorAuth/accessToken` and `cursorAuth/refreshToken` in its
 * globalStorage SQLite (`state.vscdb`, ItemTable). Both are plain session JWTs.
 *
 * Usage:
 *   node scripts/import-local-token.mjs [--out accounts.json] [--label name]
 *                                       [--db /path/to/state.vscdb] [--merge]
 *
 * Prints only non-secret metadata (label, expiry). Written with mode 0600.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const merge = args.includes("--merge");

function defaultDb() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData/Roaming"), "Cursor/User/globalStorage/state.vscdb");
  }
  return path.join(home, ".config/Cursor/User/globalStorage/state.vscdb");
}

const db = opt("db", defaultDb());
const out = opt("out", "accounts.json");

if (!existsSync(db)) {
  console.error(`state.vscdb not found: ${db}`);
  process.exit(1);
}

function read(key) {
  const json = execFileSync(
    "sqlite3",
    ["-json", db, `SELECT value FROM ItemTable WHERE key='${key.replace(/'/g, "''")}';`],
    { encoding: "utf8" },
  );
  const rows = JSON.parse(json || "[]");
  if (rows.length === 0) return "";
  let v = rows[0].value;
  try {
    const parsed = JSON.parse(v);
    if (typeof parsed === "string") v = parsed;
  } catch {
    /* plain string */
  }
  return String(v ?? "");
}

const accessToken = read("cursorAuth/accessToken");
const refreshToken = read("cursorAuth/refreshToken");
const email = read("cursorAuth/cachedEmail");
const membership = read("cursorAuth/stripeMembershipType");

if (!accessToken) {
  console.error("no cursorAuth/accessToken in state.vscdb — sign in to Cursor first");
  process.exit(1);
}

function jwtExpiry(jwt) {
  const part = jwt.split(".")[1];
  if (!part) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof claims.exp === "number" ? new Date(claims.exp * 1000).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

const label = opt("label", email || "local");
const account = {
  label,
  accessToken,
  ...(refreshToken ? { refreshToken } : {}),
  ...(jwtExpiry(accessToken) ? { expiresAt: jwtExpiry(accessToken) } : {}),
};

let accounts = [account];
if (merge && existsSync(out)) {
  const existing = JSON.parse(readFileSync(out, "utf8"));
  const list = Array.isArray(existing) ? existing : (existing.accounts ?? []);
  accounts = [...list.filter((a) => a.label !== label), account];
}

writeFileSync(out, `${JSON.stringify(accounts, null, 2)}\n`, { mode: 0o600 });

console.log(`wrote ${out} (mode 0600)`);
console.log(`  label:      ${label}`);
console.log(`  membership: ${membership || "unknown"}`);
console.log(`  expires:    ${account.expiresAt ?? "unknown"}`);
console.log(`  refresh:    ${refreshToken ? "present" : "MISSING (token cannot be auto-renewed)"}`);
console.log(`  accounts:   ${accounts.length}`);
