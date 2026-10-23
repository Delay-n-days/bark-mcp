# bark-mcp

把 [Bark](https://bark.day.app)（iOS 推送）包成一个 **TypeScript** 的单文件服务：
既可以在浏览器里当推送游乐场点着玩，也可以作为 **MCP 服务**让大模型直接给你的手机发通知。
**Bun 和 Node（≥ 20）都能跑**，产物同一个文件。

```
bunx bark-mcp          # 游乐场 + MCP (http://127.0.0.1:8787)
bunx bark-mcp mcp      # stdio MCP，给 Claude Code / Codex / Cursor 用
```

仓库只发布一个文件：`dist/bark-mcp.js`（约 620 KB，含页面、加密、MCP）。运行时不需要 `node_modules`。

---

## 特性

- **Bark 全参数**：标题 / 副标题 / 正文 / Markdown / 分组 / 图标 / 大图 / 角标 / 级别 / 音量 / 铃声 / 循环响铃 / 自动复制 / 跳转 URL / action / 存档 / TTL / 进度更新 / 静默删除。
- **官方加密方案**：AES-128/192/256 × CBC/ECB/GCM，与 Bark App「推送加密」互通；GCM 认证标签按 App 约定拼在密文尾部。
- **两套界面同源**：Web 游乐场的场景库和 MCP 工具用的是同一份 `scenarios.ts`，模型看到的和你在页面上点的是同一批效果。
- **单文件产物**：`bun build --target=bun` 把 HTML 以 text 内联，`bunx` 可直接跑，也可 `chmod +x` 后当脚本用。
- **认证简单**：`BARK_KEY` 既是默认推送目标，也是 HTTP 服务的 bearer token。

---

## 安装

需要 [Bun](https://bun.sh) ≥ 1.1 **或** Node ≥ 20，两者皆可，产物是同一个 `dist/bark-mcp.js`。

### 直接用发布产物

```bash
git clone https://github.com/<you>/bark-mcp && cd bark-mcp
cp .env.example .env      # 填 BARK_KEY
bun dist/bark-mcp.js   # 或 bun run build && bun dist/bark-mcp.js
```

### 从源码开发

```bash
bun install
bun run dev        # 热跑的游乐场 + MCP
bun test           # 61 个测试（加密向量、payload、MCP 工具、HTTP 端点）
bun run typecheck
bun run build      # 产出 dist/bark-mcp.js 并做冒烟测试
```

---

## 配置

优先级：**真实环境变量 > `.env`**。`.env` 会从当前工作目录和可执行文件所在目录依次查找。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BARK_KEY` | 空 | 必填。Bark 设备 key，同时作为 HTTP/MCP 的访问令牌 |
| `BARK_SERVER` | `https://api.day.app` | Bark 服务器地址，可换成自建服务 |
| `BARK_HOST` | `127.0.0.1` | 监听地址；非回环地址会强制开启认证 |
| `BARK_PORT` | `8787` | 监听端口 |
| `BARK_REQUIRE_AUTH` | 未设置 | 设为 `1` 时即使只监听本机也校验令牌 |
| `BARK_MCP_TOKEN` | 空 | 想用别的字符串当令牌时设置它（不强依赖 `BARK_KEY`） |
| `BARK_ALLOW_CUSTOM_KEY` | `1` | 设为 `0` 后调用方不能自带 `device_key` |
| `BARK_KEYS_FILE` | `./crypto_keys.json` | 自定义密钥文件；文件里合法的密钥优先于内置默认值 |

`.env` 示例见 [`.env.example`](.env.example)。

---

## 运行环境

两种运行时跑的是**同一个** `dist/bark-mcp.js`，不必重新构建：

| 运行时 | CLI / stdio MCP | Web + HTTP MCP (`serve`) |
| --- | --- | --- |
| Bun ≥ 1.1 | ✅ | ✅ |
| Node ≥ 20 | ✅ | ✅ |

`serve` 走的是内置的 `node:http` 适配层（`src/node-adapter.ts`），把请求桥成标准
`Request`/`Response` 交给 MCP SDK 的 Web 传输层，所以 SSE 流式响应在 Node 上也是正常的。
用 Node 时把命令里的 `bun` 换成 `node` 即可：

```bash
node dist/bark-mcp.js          # 游乐场 + MCP
node dist/bark-mcp.js mcp      # stdio MCP
node dist/bark-mcp.js push --title hi --body hello
```

MCP 配置里同理，`"command": "node"` + `"args": ["/path/to/dist/bark-mcp.js", "mcp"]`。
只有从源码构建（`bun run build`）需要 Bun，跑产物不需要。

---

## 三种用法

### 1. 命令行发推送

```bash
bun dist/bark-mcp.js push --title "构建完成" --body "耗时 42s" --group ci
bun dist/bark-mcp.js push --scenario progress --json '{"body":"已完成 80%"}'
bun dist/bark-mcp.js push --title "机密" --body "只有手机能看到" --encrypt --algorithm aes-256 --mode gcm
bun dist/bark-mcp.js scenarios          # 列出所有预设场景
bun dist/bark-mcp.js key --regen aes-128  # 换一把 AES-128 KEY
```

`push` 支持全部 Bark 参数（`--device-keys k1,k2` 批量推送），完整列表见 `--help`。

### 2. Web 游乐场

```bash
bun dist/bark-mcp.js        # → http://127.0.0.1:8787
```

点场景 → 点发送，右侧能看到 Bark 原始返回、实际请求参数、密文与 IV。
含密钥的接口需要 `Authorization: Bearer <BARK_KEY>`；只监听回环地址时默认放行，方便本地调试。
如果服务端配置了令牌而页面没带，右上角会出现「填 KEY」按钮，填一次存在 `localStorage`。

### 3. MCP 服务

**stdio**（推荐给命令行 agent）：

```bash
bun dist/bark-mcp.js mcp
```

Claude Code / Codex 的 MCP 配置示例：

```json
{
  "mcpServers": {
    "bark": {
      "command": "bun",
      "args": ["/absolute/path/to/bark-mcp/dist/bark-mcp.js", "mcp"],
      "env": {
        "BARK_KEY": "your-device-key",
        "BARK_SERVER": "https://api.day.app"
      }
    }
  }
}
```

发布到 npm 后也可以直接：

```json
{ "mcpServers": { "bark": { "command": "bunx", "args": ["bark-mcp", "mcp"], "env": { "BARK_KEY": "..." } } } }
```

**Streamable HTTP**（和游乐场同一个进程）：

```bash
bun dist/bark-mcp.js      # MCP 端点在 http://127.0.0.1:8787/mcp
```

只监听 `127.0.0.1` 时该端点默认不校验令牌；一旦 `BARK_HOST` 不是回环地址，
就必须带 `Authorization: Bearer <BARK_KEY>`（或设置 `BARK_REQUIRE_AUTH=1` 让本地也强制校验）：

```bash
pi mcp add bark --url http://127.0.0.1:8787/mcp --description "Bark iOS 推送：发通知、场景库、AES 加密"
```

```json
{
  "mcpServers": {
    "bark": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer your-device-key" }
    }
  }
}
```

如果服务端要求令牌，用 `pi mcp add bark --url http://127.0.0.1:8787/mcp --bearer-token-env-var BARK_KEY` 注入，别把 key 写进配置文件。

HTTP 模式是有状态的：一次 `initialize` 建立一个会话，服务端每小时回收闲置会话；未知名会话返回 404，客户端重新 `initialize` 即可。

---

## MCP 工具

| 工具 | 作用 |
| --- | --- |
| `bark_push` | 主入口，覆盖 Bark 全部参数，可 `encrypt: true` 走加密链路 |
| `bark_scenarios` | 列出内置场景（可按分组过滤），模型不用记参数就能挑效果 |
| `bark_scenario_push` | 发送内置场景，支持 `overrides` 覆盖字段，如把进度改成 80% |
| `bark_encrypt` | 只加密不发送，返回 ciphertext / iv，排查 App 解密失败 |
| `bark_status` | 服务器地址、是否配了 BARK_KEY（脱敏）、Bark 服务器是否可达 |
| `bark_crypto_keys` | 读取当前密钥，或 `regenerate` 重新生成某算法密钥 |

`bark_push` 的 `extra` 对象可以透传任何 Bark 新字段，不用等工具更新。

设计取舍：

- **默认目标写死在服务端**。`BARK_KEY` 是默认设备，模型不需要也不应该知道它；只有用户明确要多设备时才传 `device_key`。
- **场景即能力**。「进度条」靠同一个 `id` 反复更新，「验证码」靠 `copy + automaticallycopy`，这些都是参数组合的知识，直接做成工具比让模型背文档更可靠。
- **返回值给人类可读摘要 + 机器可读 JSON**。摘要里有成功/失败、目标（脱敏）、算法模式，后面附请求体与 Bark 原文。

---

## 加密

Bark App 首页 →「推送加密」里填算法、模式和 KEY；服务端 `/api/config`（或 `bark_crypto_keys`）给出同一份密钥即可互通。

```bash
bun dist/bark-mcp.js key            # 查看当前密钥
bun dist/bark-mcp.js key --regen aes-256   # 生成新 key 并写入密钥文件
```

**默认密钥写死在 `src/config.ts` 的 `DEFAULT_KEYS` 里**，所以单文件产物丢到任何机器上都能和 App 对上，不需要额外文件：

```json
{
  "aes-128": "YChh4ziPE1eeaFZU",
  "aes-192": "0mLAQ5oJmqdVUWajtjVEAy4K",
  "aes-256": "K9tq3DK7MbidKqRUoJeJdvcxpOKHeFDX"
}
```

优先级：`BARK_KEYS_FILE` 指向的文件里的合法值 > 内置 `DEFAULT_KEYS`。
想换成自己的 key，改 `DEFAULT_KEYS` 重新 `bun run build`，或用 `BARK_KEYS_FILE` 指一个自己的密钥文件；
纯读默认值时不会落盘，只有 `--regen` 或文件里已有有效 key 才会写 `crypto_keys.json`。

实现要点：

- 明文先用紧凑 JSON（`JSON.stringify`，保留中文、无空格）编码再加密；
- CBC 的 IV 是 16 位十六进制字符串，GCM 的 IV 是 12 位；
- GCM 的认证标签附加在密文尾部，与 Bark App 解密扩展的约定一致；
- 加密模式下 Bark 只收到 `device_key + ciphertext + iv`，但 `id` / `delete` 会额外明文透传（静默删除不经过解密扩展）；
- 测试里固化了 Bark 官方文档的 AES-128-CBC 向量，改实现不会被悄悄改坏。

---

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/` | 游乐场页面（无需令牌） |
| `GET` | `/api/config` | 服务器、脱敏 key、算法/模式、场景列表 |
| `POST` | `/api/push` | 发送推送，body 即 Bark payload，另支持 `scenario` / `encrypt` / `algorithm` / `mode` |
| `POST` | `/api/crypto/regenerate` | `{ "algorithm": "aes-128" }` 重新生成密钥 |
| `GET/POST/DELETE` | `/mcp` | Streamable HTTP MCP |

```bash
curl -X POST http://127.0.0.1:8787/api/push \
  -H "Authorization: Bearer $BARK_KEY" \
  -H 'content-type: application/json' \
  -d '{"title":"hi","body":"hello","encrypt":true}'
```

---

## 目录结构

```
src/
  main.ts         CLI 入口（serve / mcp / push / scenarios / key）
  config.ts       .env、环境变量、crypto_keys.json
  crypto.ts       AES 加密与自检向量
  bark.ts         Bark 客户端与推送编排
  scenarios.ts    场景库（Web 与 MCP 共用）
  http.ts         游乐场 + Streamable HTTP MCP
  node-adapter.ts node:http ↔ Web Request/Response 桥接（让 Node 也能 serve）
  mcp/server.ts   MCP 工具定义与实现
  mcp/stdio.ts    stdio 入口
  web/index.html  游乐场页面（构建时以文本内联）
test/
  core.test.ts    加密向量、payload、Bark 响应判定
  mcp.test.ts     六个工具的端到端行为
  http.test.ts    认证、API、MCP 会话
scripts/build.ts  单文件打包 + 冒烟测试
python-legacy/    最初的 FastAPI 实现，仅作参考
```

---

## 安全说明

- 单文件产物里**不含** `BARK_KEY`（运行时从环境变量 / `.env` 读取）；加密密钥是写死的默认值，按设计不保密，`BARK_KEY` 才是真正的凭证。
- `.env` 与 `crypto_keys.json` 已加入 `.gitignore`，别提交。
- 监听非回环地址时必须配置令牌，否则进程直接拒绝启动。
- 任何拿到 `BARK_KEY` 的人都能给你的手机发通知，泄漏后请在 Bark App 里重置设备 key。

## License

MIT
