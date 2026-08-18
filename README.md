# cursor2api

**Use your Cursor subscription as an OpenAI-compatible API.**

[![license](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![image](https://img.shields.io/badge/ghcr.io-cursor2api-blue)](https://github.com/AstroQore/cursor2api/pkgs/container/cursor2api)

[中文文档](README.zh-CN.md)

> **Not the same project as [7836246/cursor2api](https://github.com/7836246/cursor2api).**
> That one wraps Cursor's free public docs chatbot; this one uses *your own paid
> subscription* through Cursor's agent backend.

It talks to Cursor's own `agent.v1.AgentService` backend directly — Connect-RPC over
HTTP/2 with protobuf — and exposes it as `/v1/chat/completions`. No `cursor-agent`
CLI subprocess, no headless browser, no scraping.

```
your app ──► /v1/chat/completions ──► cursor2api ──► api2.cursor.sh
             (OpenAI shape)            (protocol bridge)     (your subscription)
```

| | |
|---|---|
| Streaming (SSE) | ✅ |
| **Real `tool_calls`** with decoded arguments | ✅ |
| Multi-turn agent loops (tool results replayed) | ✅ |
| **Caller controls the tool set** — Cursor's native tools hidden | ✅ |
| 200+ models, fetched live from your account | ✅ |
| Multi-account pool, round-robin + cooldown | ✅ |
| Automatic token refresh | ✅ |
| Client-supplied `system` prompt | ⚠️ best effort — [see below](#limitations) |

## Quick start

### Docker Compose (recommended)

```bash
git clone https://github.com/AstroQore/cursor2api.git
cd cursor2api
mkdir -p data

# 1. sign in — prints a URL, open it in any browser and approve
docker compose run --rm cursor2api node scripts/login.mjs --out /data/accounts.json

# 2. start
docker compose up -d

# 3. use it
curl http://127.0.0.1:8790/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"cursor-claude-sonnet-5-thinking-high","messages":[{"role":"user","content":"hi"}]}'
```

`docker compose up -d` pulls the published image, or builds from source if the
registry copy is unavailable — either way the command is the same.

### Docker (single command)

```bash
docker run --rm -it -v "$PWD/data:/data" ghcr.io/astroqore/cursor2api:latest \
  node scripts/login.mjs --out /data/accounts.json

docker run -d --name cursor2api -p 8790:8790 -v "$PWD/data:/data" \
  ghcr.io/astroqore/cursor2api:latest
```

### From source (Node 20+)

```bash
npm install
npm run login          # or: npm run import-local   (reads a local Cursor install)
npm run build:bundle
node dist/index.cjs
```

## Signing in

Two ways to get a token into `accounts.json`:

**`npm run login`** — the browser deep-link flow Cursor's own CLI uses. It prints a
`cursor.com/loginDeepControl` URL, you approve it in any browser on any machine, and
the tokens land in `accounts.json`. Works on a headless VPS. Add `--proxy socks5://…`
if the box needs one to reach `cursor.com`.

**`npm run import-local`** — reads `cursorAuth/accessToken` from an existing Cursor
desktop install (`state.vscdb`). Handy on your own laptop.

Both write mode-0600 files and print only metadata, never the tokens. For several
accounts, run either with `--merge --label some-name`; the pool round-robins over them
and cools an account down for 60s after a failure.

Access tokens last about two months and are refreshed automatically via the refresh
token, so a one-time login is normally all you need.

## Using it

Model names are the upstream ids with a `cursor-` prefix (`CURSOR_DIRECT_MODEL_PREFIX=`
to disable). `GET /v1/models` lists whatever your account can actually reach.

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8790/v1", api_key="unused")

print(client.chat.completions.create(
    model="cursor-claude-sonnet-5-thinking-high",
    messages=[{"role": "user", "content": "Explain HTTP/2 in one sentence."}],
).choices[0].message.content)
```

Tool calling works the normal way — declare `tools`, get `tool_calls` back, send the
result as a `role: "tool"` message:

```python
resp = client.chat.completions.create(
    model="cursor-claude-opus-5-thinking-high",
    messages=[{"role": "user", "content": "Weather in Osaka?"}],
    tools=[{"type": "function", "function": {
        "name": "get_weather",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
    }}],
)
resp.choices[0].message.tool_calls[0].function.arguments   # '{"city":"Osaka"}'
```

Anything that speaks OpenAI works: Cline, Roo, Continue, LobeChat, one-api, your own
scripts. If you aggregate several subscription providers behind
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), see
[docs/deploy-behind-cliproxyapi.md](docs/deploy-behind-cliproxyapi.md).

## Configuration

All env vars, all optional.

| Variable | Default | Purpose |
|---|---|---|
| `CURSOR_DIRECT_HOST` / `_PORT` | `127.0.0.1` / `8790` | Listener (the image sets host to `0.0.0.0`) |
| `CURSOR_DIRECT_API_KEY` | — | Require `Authorization: Bearer <key>`. **Set this if the port is reachable from anywhere but localhost.** |
| `CURSOR_DIRECT_AUTH_FILE` | `./accounts.json` | Account/token store |
| `CURSOR_DIRECT_MODEL_PREFIX` | `cursor-` | Prefix on exposed model names |
| `CURSOR_ALLOWED_NATIVE_TOOLS` | `mcp_tool_call` | Which of Cursor's native tools the model may see. `*` keeps all 41. |
| `CURSOR_DIRECT_PROXY_URL` | — | SOCKS5 for all upstream traffic, e.g. `socks5://127.0.0.1:1080` |
| `CURSOR_DIRECT_CLIENT_VERSION` | `cli-2026.08.11-…` | Bump if Cursor version-gates old clients |
| `CURSOR_DIRECT_SYSTEM_AS_HISTORY` | `true` | How `system` messages are delivered (see below) |
| `CURSOR_DIRECT_TIMEOUT_MS` | `300000` | Upstream turn timeout |

## How it works

Cursor's backend is an **agent** protocol, not a model API, so the bridge has to do
real translation rather than forwarding:

- **History travels out-of-band.** Messages are serialized to JSON blobs keyed by
  sha256 and only the ids go in the request; the server then *pulls* the contents back
  over a KV channel mid-stream.
- **`Run` is a bidirectional stream.** One turn is: `run_request` → server fetches
  blobs → `request_context` handshake (where the caller's tools are declared) → text
  deltas → `turn_ended`.
- **Tool calls are bridged across two different models of the world.** Cursor drives
  tools server-side over an exec channel; OpenAI clients execute tools themselves. So
  when the model asks for a tool, the turn is ended with `finish_reason: tool_calls`
  and the caller's `role: "tool"` reply is replayed as history on the next request.
- **`x-cursor-agent-allowed-tools`** is what hides Cursor's 41 built-in tools, so the
  model sees exactly the tools your client declared. This header is only reachable on
  the direct protocol — the CLI does not forward its `--exclude-tools` flag on the
  normal run path, which is the main reason this project exists.

Two wire details that cost time if you're building something similar: streaming uses
`application/connect+proto` with 5-byte framing while unary calls use
`application/proto` with a bare body (mixing them returns a bodyless `415`), and tool
arguments arrive as `map<string, bytes>` where each value is a serialized
`google.protobuf.Value`.

## Limitations

**Client `system` prompts are best-effort.** Cursor's server composes the model prompt
itself. A real `{"role":"system"}` entry is fetched from the blob store and then
discarded — a canary string placed there never reaches the model. Only conversation
history is delivered, so your `system` message is sent as the opening exchange,
labelled as configuration from the gateway operator. In practice the model follows it;
sometimes it declines part of it, and that answer is passed back to you unchanged. The
proto field intended for this (`custom_system_prompt`) is documented upstream as
*"Allowlisted for specific teams only"*.

**Cursor's coding-assistant persona is always present.** Even with an empty request
context the model still identifies as a Cursor assistant.

**`prompt_tokens` is always 0.** The wire protocol reports a single token counter with
no prompt/completion split.

**`todo_write` stays visible.** It is resolved server-side and ignores the tool
allow-list. Harmless — it never asks the client to execute anything.

## Acknowledgements

This project stands on other people's reverse-engineering. Specifically:

- **[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)** — `proto/agent.proto` is
  vendored from its Cursor provider. It also established that
  `conversation_state.root_prompt_messages_json` is the channel the server uses to
  build the model prompt, and that tokens are refreshed at
  `/auth/exchange_user_api_key`. By far the biggest debt.
- **[AmazingAng/auth2api](https://github.com/AmazingAng/auth2api)** — the
  `loginDeepControl` + `auth/poll` PKCE login flow that `scripts/login.mjs` follows.
- **[sdsdsdsdsdsihdkjsdjl/cursoride2api](https://github.com/sdsdsdsdsdsihdkjsdjl/cursoride2api)**
  — its endpoint catalogue documents which of the legacy `aiserver.v1` RPCs are dead.
- **[eisbaw/cursor_api_demo](https://github.com/eisbaw/cursor_api_demo)** — early
  reverse engineering of the backend endpoints and the client checksum.
- **[burpheart/cursor-tap](https://github.com/burpheart/cursor-tap)** — gRPC traffic
  analysis tooling and notes.
- **[anyrobert/cursor-api-proxy](https://github.com/anyrobert/cursor-api-proxy)** — the
  CLI-wrapper approach that came first; this project is what you build after hitting
  its ceiling.
- **[router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** — the
  "OAuth login → usable API" pattern that this follows, and a good place to put this
  behind if you aggregate several providers.

## License

[AGPL-3.0](LICENSE). Note the network clause: if you run a modified version of this
service and let other people reach it over a network, you have to offer them the
source of your modified version. Running it unmodified, or purely for yourself,
carries no such obligation.

## Legal

This is an unofficial client for a private, undocumented API. It is not affiliated
with or endorsed by Anysphere. It can break whenever Cursor changes its client
contract, and using it may conflict with Cursor's terms of service — check them, and
use your own account. Traffic counts against your own subscription quota.
