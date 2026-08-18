# cursor2api

**把你的 Cursor 订阅变成 OpenAI 兼容 API。**

[![license](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

[English](README.md)

> **与 [7836246/cursor2api](https://github.com/7836246/cursor2api) 不是同一个项目。**
> 那个封装的是 Cursor 官网免费的文档问答接口；本项目用的是**你自己的付费订阅**，
> 走 Cursor 的 agent 后端。

直连 Cursor 自己的 `agent.v1.AgentService` 后端（Connect-RPC over HTTP/2 + protobuf），
对外暴露成 `/v1/chat/completions`。不起 `cursor-agent` CLI 子进程，不用无头浏览器，
不做网页抓取。

```
你的应用 ──► /v1/chat/completions ──► cursor2api ──► api2.cursor.sh
             (OpenAI 格式)             (协议翻译层)           (你的订阅)
```

| | |
|---|---|
| 流式（SSE） | ✅ |
| **真 `tool_calls`**，参数正确解码 | ✅ |
| 多轮 agent loop（工具结果回放） | ✅ |
| **工具集由调用方控制** —— Cursor 自带工具全部隐藏 | ✅ |
| 200+ 模型，按账号实时拉取 | ✅ |
| 多账号池，轮询 + 失败冷却 | ✅ |
| token 自动刷新 | ✅ |
| 客户端 `system` 提示词 | ⚠️ 尽力而为，[见下](#已知限制) |

## 快速开始

### Docker Compose（推荐）

```bash
git clone https://github.com/AstroQore/cursor2api.git
cd cursor2api
mkdir -p data

# 1. 登录 —— 会打印一个 URL，用任意浏览器打开并确认
docker compose run --rm cursor2api node scripts/login.mjs --out /data/accounts.json

# 2. 启动
docker compose up -d

# 3. 用起来
curl http://127.0.0.1:8790/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"cursor-claude-sonnet-5-thinking-high","messages":[{"role":"user","content":"你好"}]}'
```

`docker compose up -d` 会拉取已发布的镜像；拉不到时自动从源码构建，命令不变。

### Docker（单条命令）

```bash
docker run --rm -it -v "$PWD/data:/data" ghcr.io/astroqore/cursor2api:latest \
  node scripts/login.mjs --out /data/accounts.json

docker run -d --name cursor2api -p 8790:8790 -v "$PWD/data:/data" \
  ghcr.io/astroqore/cursor2api:latest
```

### 源码运行（Node 20+）

```bash
npm install
npm run login          # 或：npm run import-local  （从本机已装的 Cursor 读）
npm run build:bundle
node dist/index.cjs
```

## 登录方式

两种方式往 `accounts.json` 里放 token：

**`npm run login`** —— Cursor CLI 自己用的浏览器 deep-link 流程。打印一个
`cursor.com/loginDeepControl` 链接，你在任意机器的任意浏览器里确认，token 就写进
`accounts.json`。**无头 VPS 上也能用**。机器需要代理才能访问 `cursor.com` 的话，加
`--proxy socks5://…`。

**`npm run import-local`** —— 从本机已安装的 Cursor 桌面端读取（`state.vscdb` 里的
`cursorAuth/accessToken`）。自己电脑上更省事。

两个脚本都写 0600 权限的文件，只打印元信息，不打印 token。多账号就带
`--merge --label 名字` 各跑一次；池子会轮询，某个账号失败后冷却 60 秒。

access token 有效期约两个月，到期前会用 refresh token 自动续，所以正常只需登录一次。

## 怎么用

模型名 = 上游 id 加 `cursor-` 前缀（设 `CURSOR_DIRECT_MODEL_PREFIX=` 可关掉）。
`GET /v1/models` 返回你账号实际能用的全部模型。

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8790/v1", api_key="unused")

print(client.chat.completions.create(
    model="cursor-claude-sonnet-5-thinking-high",
    messages=[{"role": "user", "content": "一句话解释 HTTP/2"}],
).choices[0].message.content)
```

工具调用就是标准流程 —— 声明 `tools`，拿到 `tool_calls`，把结果作为
`role: "tool"` 消息发回去：

```python
resp = client.chat.completions.create(
    model="cursor-claude-opus-5-thinking-high",
    messages=[{"role": "user", "content": "大阪天气？"}],
    tools=[{"type": "function", "function": {
        "name": "get_weather",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
    }}],
)
resp.choices[0].message.tool_calls[0].function.arguments   # '{"city":"Osaka"}'
```

任何吃 OpenAI 格式的东西都能接：Cline、Roo、Continue、LobeChat、one-api，或者你自己的
脚本。如果你用 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 聚合多个
订阅型 provider，见 [docs/deploy-behind-cliproxyapi.md](docs/deploy-behind-cliproxyapi.md)。

## 配置

全部是环境变量，全部可选。

| 变量 | 默认值 | 作用 |
|---|---|---|
| `CURSOR_DIRECT_HOST` / `_PORT` | `127.0.0.1` / `8790` | 监听地址（镜像里 host 是 `0.0.0.0`） |
| `CURSOR_DIRECT_API_KEY` | — | 要求 `Authorization: Bearer <key>`。**端口不只是 localhost 可达时务必设置。** |
| `CURSOR_DIRECT_AUTH_FILE` | `./accounts.json` | 账号 / token 存储 |
| `CURSOR_DIRECT_MODEL_PREFIX` | `cursor-` | 暴露的模型名前缀 |
| `CURSOR_ALLOWED_NATIVE_TOOLS` | `mcp_tool_call` | 允许模型看到哪些 Cursor 原生工具，`*` = 全部 41 个 |
| `CURSOR_DIRECT_PROXY_URL` | — | 全部上游流量走 SOCKS5，如 `socks5://127.0.0.1:1080` |
| `CURSOR_DIRECT_CLIENT_VERSION` | `cli-2026.08.11-…` | Cursor 卡旧客户端版本时改这里 |
| `CURSOR_DIRECT_SYSTEM_AS_HISTORY` | `true` | `system` 消息的投递方式（见下） |
| `CURSOR_DIRECT_TIMEOUT_MS` | `300000` | 上游单轮超时 |

## 实现原理

Cursor 后端是 **agent 协议**，不是模型 API，所以这层做的是真翻译而不是转发：

- **历史走带外通道。** 消息序列化成 JSON blob、以 sha256 为 id，请求里只带 id；
  服务端在流中途**反向来拉**内容。
- **`Run` 是双向流。** 一轮的顺序是：`run_request` → 服务端拉 blob →
  `request_context` 握手（调用方的工具在这里声明）→ 文本增量 → `turn_ended`。
- **工具调用要在两套世界观之间缝合。** Cursor 是服务端通过 exec 通道驱动工具，
  OpenAI 是调用方自己执行。所以模型要调工具时，这层直接以
  `finish_reason: tool_calls` 结束该轮，下一轮把调用方回传的 `role: "tool"`
  作为历史重放。
- **`x-cursor-agent-allowed-tools`** 是隐藏 Cursor 那 41 个内置工具的开关，让模型
  只看得到你声明的工具。这个头**只有直连协议才能用** —— CLI 在正常运行路径上不转发
  它的 `--exclude-tools` 参数，这正是本项目存在的主要理由。

另外两个协议细节，如果你也在做类似的东西会省不少时间：流式用
`application/connect+proto` + 5 字节封帧，而一元调用用 `application/proto` + 裸消息体
（混用会得到一个没有 body 的 `415`）；工具参数是 `map<string, bytes>`，每个 value 是
序列化的 `google.protobuf.Value`。

## 已知限制

**客户端 `system` 提示词是尽力而为。** 模型提示词由 Cursor 服务端自己拼装。真正的
`{"role":"system"}` 条目服务端会拉取然后丢弃 —— 放一个 canary 字符串进去，模型完全
不知道。只有对话历史会送达，所以你的 `system` 消息被放在开场那一轮，并如实标注为
"本网关运营方的会话配置"。实测模型会遵守；偶尔它会拒绝其中一部分，那个回答会原样返回
给你。协议里真正为此设计的字段（`custom_system_prompt`）在上游 proto 注释里写着
*"Allowlisted for specific teams only"*。

**Cursor 的编程助手人格始终在。** 即使请求上下文完全为空，模型仍会自称 Cursor 助手。

**`prompt_tokens` 恒为 0。** 协议只回一个 token 计数，没有 prompt/completion 拆分。

**`todo_write` 关不掉。** 它由服务端自解析，不受工具白名单控制。无害 —— 它不会要求
客户端执行任何东西。

## 致谢

这个项目建立在别人的逆向工作之上：

- **[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)** —— `proto/agent.proto`
  取自它的 Cursor provider。它还确认了
  `conversation_state.root_prompt_messages_json` 才是服务端拼装模型提示词所用的通道，
  以及 token 刷新端点是 `/auth/exchange_user_api_key`。欠得最多的一份。
- **[AmazingAng/auth2api](https://github.com/AmazingAng/auth2api)** ——
  `scripts/login.mjs` 遵循的 `loginDeepControl` + `auth/poll` PKCE 登录流程。
- **[sdsdsdsdsdsihdkjsdjl/cursoride2api](https://github.com/sdsdsdsdsdsihdkjsdjl/cursoride2api)**
  —— 它的端点清单记录了哪些老的 `aiserver.v1` RPC 已经废弃。
- **[eisbaw/cursor_api_demo](https://github.com/eisbaw/cursor_api_demo)** ——
  后端端点与客户端 checksum 的早期逆向。
- **[burpheart/cursor-tap](https://github.com/burpheart/cursor-tap)** ——
  gRPC 流量分析工具与笔记。
- **[anyrobert/cursor-api-proxy](https://github.com/anyrobert/cursor-api-proxy)** ——
  更早的 CLI 包装方案；本项目是撞到它天花板之后的产物。
- **[router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** ——
  "OAuth 登录 → 可用 API" 这个范式的来源；如果你要聚合多个 provider，把本服务挂在
  它后面是个好选择。

## 许可证

[AGPL-3.0](LICENSE)。注意其中的网络条款：如果你**修改**了本服务并把它开放给别人通过
网络使用，你需要向这些用户提供你修改版的源码。不修改直接用、或者只给自己用，则没有
这项义务。

## 法律声明

这是一个非官方客户端，对接的是未公开的私有 API，与 Anysphere 无关，也未获其背书。
Cursor 改动客户端协议时它随时可能失效，使用它可能与 Cursor 的服务条款冲突 ——
请自行确认，并且用你自己的账号。所有流量都消耗你自己的订阅额度。
