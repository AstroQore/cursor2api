/**
 * SOCKS5 tunnelling for the upstream connections.
 *
 * The service cannot be wrapped in `nsproxy` (px-jp / px-tw): nsproxy puts the child
 * in its own network namespace, so the HTTP listener becomes invisible to anything on
 * the host — including the CLIProxyAPI instance that is supposed to call it. Doing the
 * tunnelling in-process keeps the listener on the host loopback and sends only the
 * Cursor traffic through the proxy.
 *
 * Hostnames are passed to the proxy as domain names (ATYP 0x03) rather than resolved
 * locally, so DNS also happens at the exit.
 */
import net from "node:net";
import tls from "node:tls";

export interface ProxyTarget {
  host: string;
  port: number;
}

function parseProxy(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  if (!/^socks5h?:$/.test(parsed.protocol)) {
    throw new Error(`unsupported proxy scheme ${parsed.protocol} (expected socks5://)`);
  }
  return { host: parsed.hostname, port: Number(parsed.port || 1080) };
}

/** Open a raw TCP connection to `target` through a SOCKS5 proxy. */
export function socksConnect(target: ProxyTarget, proxyUrl: string, timeoutMs = 15_000): Promise<net.Socket> {
  const proxy = parseProxy(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host);
    let stage: "greeting" | "request" | "done" = "greeting";
    let buffer = Buffer.alloc(0);

    const fail = (msg: string): void => {
      socket.destroy();
      clearTimeout(timer);
      reject(new Error(`socks5 ${proxy.host}:${proxy.port} -> ${target.host}:${target.port}: ${msg}`));
    };
    const timer = setTimeout(() => fail("handshake timed out"), timeoutMs);

    socket.on("error", (err) => fail(err.message));

    socket.once("connect", () => {
      // VER=5, one method, NO AUTH
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });

    socket.on("data", (chunk) => {
      if (stage === "done") return;
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === "greeting") {
        if (buffer.length < 2) return;
        if (buffer[0] !== 0x05) return fail(`bad version 0x${buffer[0]?.toString(16)}`);
        if (buffer[1] !== 0x00) return fail(`proxy demands auth method 0x${buffer[1]?.toString(16)}`);
        buffer = buffer.subarray(2);
        stage = "request";

        const host = Buffer.from(target.host, "utf8");
        const req = Buffer.alloc(7 + host.length);
        req[0] = 0x05; // VER
        req[1] = 0x01; // CONNECT
        req[2] = 0x00; // RSV
        req[3] = 0x03; // ATYP = domain name
        req[4] = host.length;
        host.copy(req, 5);
        req.writeUInt16BE(target.port, 5 + host.length);
        socket.write(req);
        if (buffer.length === 0) return;
      }

      if (stage === "request") {
        if (buffer.length < 5) return;
        if (buffer[1] !== 0x00) return fail(`CONNECT rejected, REP=0x${buffer[1]?.toString(16)}`);
        const atyp = buffer[3]!;
        const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? 1 + buffer[4]! : -1;
        if (addrLen < 0) return fail(`bad ATYP 0x${atyp.toString(16)}`);
        const total = 4 + addrLen + 2;
        if (buffer.length < total) return;
        stage = "done";
        clearTimeout(timer);
        socket.removeAllListeners("data");
        socket.removeAllListeners("error");
        // Anything past the reply is upstream payload; push it back for the caller.
        const leftover = buffer.subarray(total);
        if (leftover.length > 0) socket.unshift(leftover);
        resolve(socket);
      }
    });
  });
}

/**
 * TLS-over-SOCKS5 socket ready to hand to `http2.connect({ createConnection })`.
 * ALPN is pinned to h2 because every Cursor endpoint we use is HTTP/2.
 */
export async function tlsOverSocks(
  baseUrl: string,
  proxyUrl: string,
  timeoutMs?: number,
): Promise<tls.TLSSocket> {
  const url = new URL(baseUrl);
  const port = Number(url.port || 443);
  const raw = await socksConnect({ host: url.hostname, port }, proxyUrl, timeoutMs);
  return new Promise((resolve, reject) => {
    const secured = tls.connect(
      { socket: raw, servername: url.hostname, ALPNProtocols: ["h2"] },
      () => resolve(secured),
    );
    secured.once("error", (err) => {
      raw.destroy();
      reject(err);
    });
  });
}
