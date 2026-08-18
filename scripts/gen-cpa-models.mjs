#!/usr/bin/env node
/**
 * Emit the `openai-compatibility` entry to paste into CLIProxyAPI's config.yaml.
 *
 * Model names come from this service's own /v1/models, so they already carry the
 * `cursor-` prefix and CPA can list them verbatim — no `alias:` mapping and no
 * CPA-side `prefix:` (which would produce `cursor/foo` rather than `cursor-foo`).
 *
 * Usage:
 *   node scripts/gen-cpa-models.mjs [--url http://127.0.0.1:8790] [--key KEY]
 *                                   [--filter substr] [--limit N]
 */
const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const base = opt("url", "http://127.0.0.1:8790").replace(/\/$/, "");
const key = opt("key", "");
const filter = opt("filter", "");
const limit = Number(opt("limit", "0"));

const res = await fetch(`${base}/v1/models`, {
  headers: key ? { Authorization: `Bearer ${key}` } : {},
});
if (!res.ok) {
  console.error(`GET ${base}/v1/models -> HTTP ${res.status}`);
  process.exit(1);
}
const body = await res.json();
let ids = (body.data ?? []).map((m) => m.id);
if (filter) ids = ids.filter((id) => id.includes(filter));
if (limit > 0) ids = ids.slice(0, limit);

if (ids.length === 0) {
  console.error("no models returned");
  process.exit(1);
}

const lines = [
  "  - name: Cursor Direct",
  `    base-url: ${base}/v1`,
  "    api-key-entries:",
  `      - api-key: "${key || "unused"}"`,
  "    models:",
  ...ids.map((id) => `      - name: "${id}"`),
];

console.log(`# ${ids.length} models — append under the existing \`openai-compatibility:\` list`);
console.log(lines.join("\n"));
