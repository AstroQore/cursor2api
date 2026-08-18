/**
 * Account pool and token lifecycle.
 *
 * The auth file is a JSON array so it can be edited by hand and hot-reloaded:
 *
 *   [
 *     { "label": "aq-main", "accessToken": "eyJ...", "refreshToken": "eyJ..." }
 *   ]
 *
 * Access tokens are session JWTs (about two months of life on current accounts).
 * `refreshToken` is exchanged at `POST /auth/exchange_user_api_key` with the refresh
 * token as the bearer, which returns a fresh pair; refreshed pairs are written back
 * to the same file atomically with 0600.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { h2Request } from "./cursor/h2.js";

const REFRESH_BASE = "https://api2.cursor.sh";
const REFRESH_PATH = "/auth/exchange_user_api_key";
/** Refresh this far ahead of expiry. */
const REFRESH_SKEW_MS = 30 * 60 * 1000;

export interface Account {
  label: string;
  accessToken: string;
  refreshToken?: string;
  /** Derived from the JWT when absent. */
  expiresAt?: string;
  /** Set when the account is failing so the pool can skip it. */
  disabledUntil?: string;
  lastError?: string;
}

export class AccountPool {
  private accounts: Account[] = [];
  private cursor = 0;
  private mtimeMs = 0;

  constructor(
    private readonly file: string,
    private readonly log: (msg: string) => void,
    /** Same SOCKS5 egress as the RPC calls, so refreshes leave from the same exit. */
    private readonly proxyUrl?: string | undefined,
  ) {
    this.reload();
  }

  reload(): void {
    if (!existsSync(this.file)) {
      if (this.accounts.length > 0 || this.mtimeMs === 0) this.log(`auth file not found: ${this.file}`);
      this.accounts = [];
      this.mtimeMs = -1;
      return;
    }
    const st = statSync(this.file);
    if (st.mtimeMs === this.mtimeMs && this.accounts.length > 0) return;
    const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Account[] | { accounts?: Account[] };
    const list = Array.isArray(parsed) ? parsed : (parsed.accounts ?? []);
    this.accounts = list
      .filter((a) => typeof a?.accessToken === "string" && a.accessToken.length > 0)
      .map((a, i) => ({ ...a, label: a.label || `account-${i + 1}` }));
    this.mtimeMs = st.mtimeMs;
    this.log(`loaded ${this.accounts.length} cursor account(s) from ${this.file}`);
  }

  /** Healthy account count. */
  size(): number {
    this.reload();
    return this.accounts.filter((a) => !isDisabled(a)).length;
  }

  labels(): string[] {
    return this.accounts.map((a) => a.label);
  }

  /** Round-robin over healthy accounts, refreshing tokens close to expiry. */
  async next(): Promise<Account> {
    this.reload();
    const healthy = this.accounts.filter((a) => !isDisabled(a));
    if (healthy.length === 0) {
      throw new Error(
        this.accounts.length === 0
          ? "no cursor account configured"
          : "all cursor accounts are in cooldown",
      );
    }
    const account = healthy[this.cursor % healthy.length]!;
    this.cursor = (this.cursor + 1) % healthy.length;
    return this.ensureFresh(account);
  }

  markFailure(account: Account, error: string, cooldownMs = 60_000): void {
    const target = this.accounts.find((a) => a.label === account.label);
    if (!target) return;
    target.lastError = error;
    target.disabledUntil = new Date(Date.now() + cooldownMs).toISOString();
    this.log(`account ${account.label} cooling down ${Math.round(cooldownMs / 1000)}s: ${error}`);
  }

  markSuccess(account: Account): void {
    const target = this.accounts.find((a) => a.label === account.label);
    if (!target) return;
    delete target.disabledUntil;
    delete target.lastError;
  }

  private async ensureFresh(account: Account): Promise<Account> {
    const expiry = account.expiresAt ? Date.parse(account.expiresAt) : jwtExpiryMs(account.accessToken);
    if (expiry && expiry - Date.now() > REFRESH_SKEW_MS) return account;
    // Without a refresh token there is nothing to do; let the request run and
    // surface the real upstream error rather than guessing here.
    if (!account.refreshToken) return account;
    try {
      const refreshed = await exchangeRefreshToken(account.refreshToken, this.proxyUrl);
      account.accessToken = refreshed.accessToken;
      if (refreshed.refreshToken) account.refreshToken = refreshed.refreshToken;
      account.expiresAt = new Date(
        jwtExpiryMs(refreshed.accessToken) ?? Date.now() + 55 * 60 * 1000,
      ).toISOString();
      this.persist();
      this.log(`refreshed ${account.label}, expires ${account.expiresAt}`);
    } catch (err) {
      this.log(`token refresh failed for ${account.label}: ${(err as Error).message}`);
    }
    return account;
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.accounts, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    this.mtimeMs = statSync(this.file).mtimeMs;
  }
}

function isDisabled(a: Account): boolean {
  return a.disabledUntil ? Date.parse(a.disabledUntil) > Date.now() : false;
}

export async function exchangeRefreshToken(
  refresh: string,
  proxyUrl?: string | undefined,
): Promise<{ accessToken: string; refreshToken?: string }> {
  const res = await h2Request({
    baseUrl: REFRESH_BASE,
    path: REFRESH_PATH,
    proxyUrl,
    body: Buffer.from("{}", "utf8"),
    headers: {
      ":method": "POST",
      authorization: `Bearer ${refresh}`,
      "content-type": "application/json",
      accept: "application/json",
    },
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`refresh HTTP ${res.status}`);
  const data = JSON.parse(res.body.toString("utf8")) as { accessToken?: string; refreshToken?: string };
  if (!data.accessToken) throw new Error("refresh response carried no accessToken");
  return { accessToken: data.accessToken, refreshToken: data.refreshToken };
}

export function jwtExpiryMs(jwt: string): number | undefined {
  const part = jwt.split(".")[1];
  if (!part) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: number };
    return typeof claims.exp === "number" ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
