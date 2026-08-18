/**
 * Minimal HTTP/2 request helper with optional SOCKS5 tunnelling.
 *
 * Shared by the unary RPC path and the token-refresh call so both honour the same
 * egress policy. The streaming turn in session.ts opens its own session because it
 * needs the raw bidirectional stream rather than a buffered response.
 */
import * as http2 from "node:http2";
import { tlsOverSocks } from "./socks.js";

export interface H2Response {
  status: number;
  headers: http2.IncomingHttpHeaders;
  body: Buffer;
}

export interface H2Options {
  baseUrl: string;
  path: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  proxyUrl?: string | undefined;
  timeoutMs?: number;
}

/** Open an http2 session to `baseUrl`, tunnelled through SOCKS5 when configured. */
export async function connectH2(
  baseUrl: string,
  proxyUrl: string | undefined,
  timeoutMs?: number,
): Promise<http2.ClientHttp2Session> {
  if (!proxyUrl) return http2.connect(baseUrl);
  const socket = await tlsOverSocks(baseUrl, proxyUrl, timeoutMs);
  return http2.connect(baseUrl, { createConnection: () => socket });
}

export async function h2Request(opts: H2Options): Promise<H2Response> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const client = await connectH2(opts.baseUrl, opts.proxyUrl, timeoutMs);
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.close();
      } catch {
        /* already closed */
      }
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error(`${opts.path} timed out`))), timeoutMs);
    client.on("error", (err) => done(() => reject(err)));

    const req = client.request({ ":path": opts.path, ...opts.headers });
    let status = 0;
    let headers: http2.IncomingHttpHeaders = {};
    const chunks: Buffer[] = [];
    req.on("response", (h) => {
      status = Number(h[":status"] || 0);
      headers = h;
    });
    req.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    req.on("error", (err) => done(() => reject(err)));
    req.on("end", () => done(() => resolve({ status, headers, body: Buffer.concat(chunks) })));
    req.end(opts.body ? Buffer.from(opts.body) : undefined);
  });
}
