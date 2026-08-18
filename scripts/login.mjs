#!/usr/bin/env node
/**
 * Sign in to Cursor and write the tokens into an account file.
 *
 * Works headlessly: it prints a URL, you open it in any browser (on any machine),
 * approve the login, and this process picks the tokens up by polling. No Cursor
 * install required on the box running the gateway.
 *
 * Flow (Cursor's own CLI deep-link login):
 *   1. generate a PKCE verifier/challenge pair plus a UUID for the attempt
 *   2. show https://cursor.com/loginDeepControl?challenge=..&uuid=..&mode=login&redirectTarget=cli
 *   3. poll https://api2.cursor.sh/auth/poll?uuid=..&verifier=.. until it returns tokens
 *
 * Usage:
 *   node scripts/login.mjs [--out accounts.json] [--label name] [--merge]
 *                          [--proxy socks5://127.0.0.1:1080]
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const out = opt("out", "accounts.json");
const merge = args.includes("--merge");
const proxyUrl = opt("proxy", process.env.CURSOR_DIRECT_PROXY_URL || "");

const LOGIN_URL = "https://www.cursor.com/loginDeepControl";
const POLL_HOST = "https://api2.cursor.sh";
const POLL_PATH = "/auth/poll";
const TIMEOUT_MS = 5 * 60 * 1000;

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const uuid = randomUUID();

const loginUrl =
  `${LOGIN_URL}?challenge=${challenge}&uuid=${uuid}&mode=login&redirectTarget=cli`;

console.log("\nOpen this URL in a browser and approve the login:\n");
console.log(`  ${loginUrl}\n`);
console.log("Waiting for approval (5 min timeout)...");

/** SOCKS5 CONNECT, so this script works from boxes that need a proxy for cursor.com. */
function socksConnect(host, port, proxy) {
  const u = new URL(proxy);
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(u.port || 1080), u.hostname);
    let stage = "greet";
    let buf = Buffer.alloc(0);
    const fail = (m) => {
      s.destroy();
      reject(new Error(`socks5: ${m}`));
    };
    s.on("error", (e) => fail(e.message));
    s.once("connect", () => s.write(Buffer.from([5, 1, 0])));
    s.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      if (stage === "greet") {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 0) return fail("handshake rejected");
        buf = buf.subarray(2);
        stage = "req";
        const h = Buffer.from(host, "utf8");
        const req = Buffer.alloc(7 + h.length);
        req[0] = 5; req[1] = 1; req[2] = 0; req[3] = 3; req[4] = h.length;
        h.copy(req, 5);
        req.writeUInt16BE(port, 5 + h.length);
        s.write(req);
        if (!buf.length) return;
      }
      if (stage === "req") {
        if (buf.length < 5) return;
        if (buf[1] !== 0) return fail(`CONNECT rejected REP=${buf[1]}`);
        const atyp = buf[3];
        const alen = atyp === 1 ? 4 : atyp === 4 ? 16 : 1 + buf[4];
        const total = 4 + alen + 2;
        if (buf.length < total) return;
        stage = "done";
        s.removeAllListeners("data");
        s.removeAllListeners("error");
        const rest = buf.subarray(total);
        if (rest.length) s.unshift(rest);
        resolve(s);
      }
    });
  });
}

/** Minimal HTTP/2 GET against api2.cursor.sh, optionally tunnelled. */
async function get(path) {
  let opts;
  if (proxyUrl) {
    const raw = await socksConnect("api2.cursor.sh", 443, proxyUrl);
    const secured = await new Promise((res, rej) => {
      const t = tls.connect({ socket: raw, servername: "api2.cursor.sh", ALPNProtocols: ["h2"] }, () => res(t));
      t.once("error", rej);
    });
    opts = { createConnection: () => secured };
  }
  return new Promise((resolve, reject) => {
    const client = http2.connect(POLL_HOST, opts);
    const chunks = [];
    let status = 0;
    const req = client.request({
      ":method": "GET",
      ":path": path,
      accept: "application/json",
      "user-agent": "cursor2api/login",
    });
    req.on("response", (h) => (status = Number(h[":status"] || 0)));
    req.on("data", (c) => chunks.push(c));
    req.on("error", (e) => {
      client.close();
      reject(e);
    });
    req.on("end", () => {
      client.close();
      resolve({ status, body: Buffer.concat(chunks).toString("utf8") });
    });
    req.end();
  });
}

const transient = (err) =>
  /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|GOAWAY|socket hang up|ERR_HTTP2/.test(
    err?.code || err?.message || "",
  );

const deadline = Date.now() + TIMEOUT_MS;
let interval = 1000;
let tokens = null;
let errors = 0;

while (Date.now() < deadline) {
  try {
    const res = await get(`${POLL_PATH}?uuid=${uuid}&verifier=${verifier}`);
    errors = 0;
    // 404 / 202 simply mean "not approved yet".
    if (res.status >= 200 && res.status < 300) {
      const data = JSON.parse(res.body || "{}");
      const accessToken = data.accessToken || data.apiKey;
      if (accessToken) {
        tokens = { accessToken, refreshToken: data.refreshToken, authId: data.authId };
        break;
      }
    } else if (res.status !== 404 && res.status !== 202) {
      console.error(`poll returned HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    }
  } catch (err) {
    if (!transient(err)) throw err;
    if (++errors > 30) throw new Error(`poll kept failing: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, interval));
  interval = Math.min(5000, Math.round(interval * 1.2));
}

if (!tokens) {
  console.error("\nTimed out before the login was approved.");
  process.exit(1);
}

function jwtClaims(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1] || "", "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

const claims = jwtClaims(tokens.accessToken);
const label =
  opt("label", "") ||
  claims.email ||
  (tokens.authId ? tokens.authId.split("|").pop() : "") ||
  "cursor";

const account = {
  label,
  accessToken: tokens.accessToken,
  ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
  ...(claims.exp ? { expiresAt: new Date(claims.exp * 1000).toISOString() } : {}),
};

let accounts = [account];
if (merge && existsSync(out)) {
  const existing = JSON.parse(readFileSync(out, "utf8"));
  const list = Array.isArray(existing) ? existing : (existing.accounts ?? []);
  accounts = [...list.filter((a) => a.label !== label), account];
}
writeFileSync(out, `${JSON.stringify(accounts, null, 2)}\n`, { mode: 0o600 });

console.log(`\nSigned in. Wrote ${out} (mode 0600)`);
console.log(`  label:    ${label}`);
console.log(`  expires:  ${account.expiresAt ?? "unknown"}`);
console.log(`  refresh:  ${tokens.refreshToken ? "present" : "MISSING — token cannot auto-renew"}`);
console.log(`  accounts: ${accounts.length}`);
if (!tokens.refreshToken) {
  console.log("\nNo refresh token came back. That usually means the deep link was confirmed in");
  console.log("API-key mode — re-run and use the normal Cursor login button.");
}
