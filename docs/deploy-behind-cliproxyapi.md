# Running behind CLIProxyAPI

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) aggregates several
subscription-backed providers behind one OpenAI-compatible endpoint. This service slots
in as an `openai-compatibility` upstream, which is a good fit if you already route
Claude Code / Codex / Gemini through CPA and want Cursor beside them.

## 1. Run the service on loopback

Keep it on `127.0.0.1` and set an API key, since CPA is the only thing that should call
it:

```ini
# /etc/cursor-direct-api/env
CURSOR_DIRECT_HOST=127.0.0.1
CURSOR_DIRECT_PORT=8790
CURSOR_DIRECT_API_KEY=<random>
CURSOR_DIRECT_AUTH_FILE=/etc/cursor-direct-api/accounts.json
CURSOR_DIRECT_PROTO_DIR=/opt/cursor-direct-api/proto
CURSOR_DIRECT_MODEL_PREFIX=cursor-
CURSOR_ALLOWED_NATIVE_TOOLS=mcp_tool_call
```

Deploy the bundle rather than the source tree if the box has `node` but no `npm`:

```bash
npm run build:bundle
rsync -a dist/index.cjs proto/ scripts/ server:/opt/cursor-direct-api/
```

## 2. Generate the CPA block

```bash
node scripts/gen-cpa-models.mjs --url http://127.0.0.1:8790 --key <the API key>
```

Append the output under the existing `openai-compatibility:` list in CPA's
`config.yaml`:

```yaml
openai-compatibility:
  - name: Cursor Direct
    base-url: http://127.0.0.1:8790/v1
    api-key-entries:
      - api-key: "<the API key>"
    models:
      - name: "cursor-claude-sonnet-5-thinking-high"
      - name: "cursor-gpt-5.6-sol-high"
      # …
```

No `alias:` and no CPA-side `prefix:` are needed — the names already read `cursor-…`.
(CPA's `prefix:` produces `cursor/foo` with a slash, which is usually not what you
want here.) CPA picks the change up on its own; watch for a
`server clients and configuration updated` line in its log.

## 3. Verify

```bash
curl -s -H "Authorization: Bearer $CPA_KEY" http://127.0.0.1:<cpa-port>/v1/models \
  | jq -r '.data[].id' | grep '^cursor-' | head
```

## Egress through a proxy

If Cursor traffic must leave from a specific region, set `CURSOR_DIRECT_PROXY_URL` to a
SOCKS5 endpoint. Do **not** wrap the process in a namespace-based redirector such as
`nsproxy`: it moves the process into its own network namespace, so the loopback
listener disappears from the host and CPA can no longer reach it — while the service
still logs that it is listening. Check the egress path with:

```bash
ss -tnp | grep "pid=$(systemctl show -p MainPID --value cursor-direct-api)"
```

The only outbound connection should be to your SOCKS port.
