/**
 * Entry point. Loads config, opens the account pool, starts the HTTP server.
 */
import { loadConfig } from "./config.js";
import { AccountPool } from "./auth.js";
import { createServer } from "./server.js";

function log(msg: string): void {
  process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
}

const config = loadConfig();
const pool = new AccountPool(config.authFile, log, config.proxyUrl);
const server = createServer({ config, pool, log });

server.listen(config.port, config.host, () => {
  log(
    `cursor-direct-api listening on http://${config.host}:${config.port} ` +
      `upstream=${config.cursorBaseUrl} prefix="${config.modelPrefix}" ` +
      `accounts=${pool.size()} allowed-native-tools=${config.allowedNativeTools.join(",") || "(all)"} ` +
      `proxy=${config.proxyUrl ?? "direct"}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`${signal} received, closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
