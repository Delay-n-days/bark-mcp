# bark-mcp

把 [Bark](https://bark.day.app)（iOS 推送）包成一个**纯 Node 的单文件服务**：
既能作为 **stdio MCP** 让大模型直接给你的手机发通知，也能在浏览器里当推送游乐场用。

```bash
npx -y <tgz 直链> mcp     # stdio MCP，给 Claude Code / Codex / pi 用
npx -y <tgz 直链>         # 游乐场 + HTTP MCP (http://127.0.0.1:8787)
```

只需要 **Node ≥ 20**，不装依赖、不需要 Bun（MCP SDK 已打包进产物）。

---

## 特性

- **Bark 全参数**：标题 / 副标题 / 正文 / Markdown / 分组 / 图标 / 大图 / 角标 / 级别 / 音量 / 铃声 / 循环响铃 / 自动复制 / 跳转 URL / action / 存档 / TTL / 进度更新 / 静默删除。
- **官方加密方案**：AES-128/192/256 × CBC/ECB/GCM，与 Bark App「推送加密」互通；GCM 认证标签按 App 约定拼在密文尾部。
- **场景库**：24 个预设（进度条、验证码、循环响铃、时效性…），Web 页面和 MCP 工具共用同一份数据，模型不用背参数也能发出复杂效果。
- **单文件产物**：`dist/bark-mcp.js`，701 KB，含页面与 MCP SDK，`npx -y` / `node` / `chmod +x` 都能跑。
- **两种传输**：stdio（本地 agent 首选）与 Streamable HTTP（和游乐场同进程）。

---

## 快速开始（只需 Node）

### 方式 A：npx 直接跑 tgz（推荐，零安装）

CI 会在打 tag 时把 tgz 传到 Release，地址形如：

```
https://github.com/Delay-n-days/bark-mcp/releases/download/v1.0.0/bark-mcp-1.0.0.tgz
```

MCP 客户端配置：

```json
{
  "mcpServers": {
    "bark": {
      "command": "npx",
      "args": [
        "-y",
        "https://github.com/Delay-n-days/bark-mcp/releases/download/v1.0.0/bark-mcp-1.0.0.tgz",
        "mcp"
      ],
      "env": {
        "BARK_KEY": "你的-device-key",
        "BARK_SERVER": "https://api.day.app"
      }
    }
  }
}
```

先手动自检一次（`mcp` 会等 stdin 上的 JSON-RPC，Ctrl+C 退出即可）：

```bash
npx -y <tgz 直链> --version
npx -y <tgz 直链> scenarios
```

### 方式 B：下载单文件

从 Release 附件里取出 tgz，解压出 `package/dist/bark-mcp.js`，或直接 clone 后本地构建。
（`dist/` 不进 git，见 [发布与 CI](#发布与-ci)。）

```bash
curl -L -o bark.tgz https://github.com/Delay-n-days/bark-mcp/releases/download/v1.0.0/bark-mcp-1.0.0.tgz
tar -xzf bark.tgz package/dist/bark-mcp.js
node package/dist/bark-mcp.js mcp
```

```json
{
  "mcpServers": {
    "bark": {
      "command": "node",
      "args": ["C:\\Users\\you\\bark-mcp.js", "mcp"],
      "env": { "BARK_KEY": "你的-device-key" }
    }
  }
}
```

### 方式 C：从源码构建

```bash
npm install
npm run build      # 生成 src/web/index-html.generated.ts + dist/bark-mcp.js
npm test           # node:test，65 个用例
npm run typecheck
```

---

## 配置

优先级：**真实环境变量 > `.env`**。`.env` 会从当前工作目录和产物所在目录依次查找。

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

## 三种用法

### 1. 命令行发推送

```bash
node bark-mcp.js push --title "构建完成" --body "耗时 42s" --group ci
node bark-mcp.js push --scenario progress --json '{"body":"已完成 80%"}'
node bark-mcp.js push --title "机密" --body "只有手机能看到" --encrypt --algorithm aes-256 --mode gcm
node bark-mcp.js scenarios               # 列出所有预设场景
node bark-mcp.js key --regen aes-128     # 换一把 AES-128 KEY
```

`push` 支持全部 Bark 参数（`--device-keys k1,k2` 批量推送），完整列表见 `--help`。

### 2. Web 游乐场

```bash
node bark-mcp.js        # → http://127.0.0.1:8787
```

点场景 → 点发送，右侧能看到 Bark 原始返回、实际请求参数、密文与 IV。
含密钥的接口需要 `Authorization: Bearer <BARK_KEY>`；只监听回环地址时默认放行，方便本地调试。
服务端要求令牌而页面没带时，右上角会出现「填 KEY」按钮，填一次存在 `localStorage`。

### 3. MCP 服务

**stdio**（命令行 agent 首选）：见上面「快速开始」的 A / B 两种配置。

**Streamable HTTP**（和游乐场同进程）：

```bash
node bark-mcp.js        # MCP 端点在 http://127.0.0.1:8787/mcp
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

pi 用户可以直接：

```bash
pi mcp add bark --url http://127.0.0.1:8787/mcp --description "Bark iOS 推送"
```

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

- **默认目标在服务端**。`BARK_KEY` 是默认设备，模型不需要也不应该知道它；只有明确要多设备时才传 `device_key`。
- **场景即能力**。「进度条」靠同一个 `id` 反复更新，「验证码」靠 `copy + automaticallycopy`，这些参数组合的知识直接做成工具，比让模型背文档更可靠。
- **返回值给人类可读摘要 + 机器可读 JSON**。摘要含成功/失败、目标（脱敏）、算法模式，后面附请求体与 Bark 原文。

---

## 加密

Bark App 首页 →「推送加密」里填算法、模式和 KEY；服务端 `/api/config`（或 `bark_crypto_keys`）给出同一份密钥即可互通。

```bash
node bark-mcp.js key                       # 查看当前密钥
node bark-mcp.js key --regen aes-256       # 生成新 key 并写入密钥文件
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
想换成自己的 key，改 `DEFAULT_KEYS` 重新 `npm run build`，或用 `BARK_KEYS_FILE` 指一个自己的密钥文件；
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

## 发布与 CI

| 工作流 | 触发 | 做什么 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | push / PR | typecheck → build → 用 `node@20` 跑产物 |
| `.github/workflows/release.yml` | 打 `v*` tag / 手动 | 同时用 Node 20 与 22 验证 → `npm pack` → **用 `npx -y ./xxx.tgz` 实测** → 上传 artifact + 附到 Release |

出 tgz：

```bash
git tag v1.0.0 && git push origin v1.0.0
```

本地出包同理（`prepack` 会自动构建）：

```bash
npm pack            # → bark-mcp-1.0.0.tgz
```

tgz 里只有 4 个文件：`package.json`、`dist/bark-mcp.js`、`README.md`、`LICENSE`。

**构建产物不进 git**：`dist/` 与 `src/web/index-html.generated.ts` 都由 CI 现场生成，
只存在于 Release 附件和 workflow artifact 里。仓库因此保持纯源码，改动可 diff。

### npx 部署的注意事项

- **URL 后面必须紧跟 `mcp` 参数**，否则默认进 `serve` 模式（起 Web 服务），stdio 客户端会连不上。
- npm 会缓存 tgz，升级版本后建议换带版本号的新地址，或 `npm cache clean --force`。Release 直链天然带版本号，避开了这个问题。
- GitHub Release 的资产直链会 302 到 `objects.githubusercontent.com`，`npx`/npm 能正常跟随；**仓库必须公开**，私有仓库需要 token。
- 公司网络拦 GitHub 时，可以把同一个 tgz 放到 jsDelivr 或对象存储，`npx -y` 只认 HTTP 可下载的 tar 包。

---

## 目录结构

```
src/
  main.ts         CLI 入口（serve / mcp / push / scenarios / key）
  config.ts       .env、环境变量、crypto_keys.json、默认密钥
  crypto.ts       AES 加密与自检向量
  bark.ts         Bark 客户端与推送编排
  scenarios.ts    场景库（Web 与 MCP 共用）
  http.ts         游乐场 + Streamable HTTP MCP
  node-adapter.ts node:http ↔ Web Request/Response 桥接
  mcp/server.ts   MCP 工具定义与实现
  mcp/stdio.ts    stdio 入口
  web/index.html  游乐场页面（真相源）
  web/index-html.generated.ts   由 gen-web 生成，供 Node 直接 import
  types.d.ts      生成模块的类型声明
test/
  assert.ts       极简断言层（node:test 之上）
  core.test.ts    加密向量、payload、Bark 响应判定、默认密钥
  mcp.test.ts     六个工具的端到端行为
  http.test.ts    认证、API、MCP 会话
scripts/
  gen-web.ts      HTML → TS 字符串模块
  build.ts        esbuild 打包单文件 + 双运行时冒烟
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
