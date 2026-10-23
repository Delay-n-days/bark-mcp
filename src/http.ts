/**
 * HTTP 入口：Web 游乐场 + Streamable HTTP MCP，共用同一份配置。
 *
 * 路由：
 *   GET  /                    游乐场页面（内嵌在单文件产物里）
 *   GET  /api/config          服务器 / 密钥 / 算法 / 场景
 *   POST /api/push            发送推送（等价于 bark_push 工具）
 *   POST /api/crypto/regenerate 重新生成某算法密钥
 *   GET|POST|DELETE /mcp      Streamable HTTP MCP 端点
 *
 * 认证：配置了 BARK_KEY 且对外监听时，必须带 `Authorization: Bearer <BARK_KEY>`。
 * 只监听回环地址时默认免认证，方便本地打开页面调试。
 */
import { timingSafeEqual } from "node:crypto";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { pushNotification, type PushOptions, type PushSettings } from "./bark.ts";
import {
  ALGOS,
  ALGORITHMS,
  MODES,
  generateKey,
  isAlgorithm,
  isMode,
  loadConfig,
  saveKeys,
  type AppConfig,
} from "./config.ts";
import { createSession, VERSION } from "./mcp/server.ts";
import { serveNode } from "./node-adapter.ts";
import { SCENARIO_GROUPS, findScenario } from "./scenarios.ts";
import INDEX_HTML from "./web/index-html.generated.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const MCP_PATH = "/mcp";
const SESSION_TTL_MS = 60 * 60 * 1000;

interface McpHttpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  lastSeen: number;
}

const sessions = new Map<string, McpHttpSession>();

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface AuthOptions {
  /** 期望的 bearer token；undefined 表示不校验 */
  token?: string;
}

export function presentedToken(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return (req.headers.get("x-bark-key") ?? "").trim();
}

export function checkAuth(req: Request, auth: AuthOptions): boolean {
  if (!auth.token) return true;
  const presented = presentedToken(req);
  return presented !== "" && constantTimeEquals(presented, auth.token);
}

function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function unauthorized(): Response {
  return json(
    { ok: false, error: "未授权：请带上 Authorization: Bearer <BARK_KEY>" },
    401,
    { "WWW-Authenticate": 'Bearer realm="bark-mcp"' },
  );
}

function mask(value: string): string {
  return value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value ? "已隐藏" : "";
}

/** 把 Web UI 提交的扁平对象翻成 PushOptions（多余的键原样透传）。 */
function parsePushOptions(body: Record<string, unknown>): PushOptions {
  const options: PushOptions = {};
  for (const [key, value] of Object.entries(body)) {
    // 控制字段不能混进 Bark payload
    if (["encrypt", "algorithm", "mode", "scenario"].includes(key)) continue;
    if (value === undefined || value === null || value === "") continue;
    options[key] = value;
  }
  return options;
}

export interface StartServerOptions {
  config?: AppConfig;
  host?: string;
  port?: number;
  /** 强制开启/关闭 bearer 认证；默认按监听地址推断 */
  requireAuth?: boolean;
  fetchImpl?: typeof fetch;
}

export interface ServerHandle {
  port: number;
  stop: (force?: boolean) => Promise<void>;
}

export function startServer(options: StartServerOptions = {}): Promise<{
  server: ServerHandle;
  url: string;
}> {
  return startServerAsync(options);
}

async function startServerAsync(options: StartServerOptions): Promise<{
  server: ServerHandle;
  url: string;
}> {
  const config = options.config ?? loadConfig();
  const host = options.host ?? (process.env.BARK_HOST?.trim() || DEFAULT_HOST);
  const port =
    options.port ?? (Number.parseInt(process.env.BARK_PORT ?? "", 10) || DEFAULT_PORT);

  const external = !isLoopback(host);
  const requireAuth =
    options.requireAuth ?? (external || process.env.BARK_REQUIRE_AUTH === "1");
  const token = requireAuth ? config.deviceKey || process.env.BARK_MCP_TOKEN?.trim() : undefined;

  if (requireAuth && !token) {
    throw new Error(
      "监听非回环地址时必须配置 BARK_KEY（或 BARK_MCP_TOKEN）作为访问令牌，" +
        "否则任何能访问端口的人都能用你的设备 key 发推送。",
    );
  }
  const auth: AuthOptions = token ? { token } : {};

  const sessionForRequest = async (sessionId: string | null, req: Request): Promise<Response> => {
    if (sessionId) {
      const existing = sessions.get(sessionId);
      if (!existing) return json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }, 404);
      existing.lastSeen = Date.now();
      return existing.transport.handleRequest(req);
    }
    if (req.method !== "POST") {
      return json({ jsonrpc: "2.0", error: { code: -32000, message: "Missing mcp-session-id" }, id: null }, 400);
    }

    const cloned = req.clone();
    let parsed: unknown;
    try {
      parsed = await cloned.json();
    } catch {
      return json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, 400);
    }
    if (!isInitializeRequest(parsed)) {
      return json({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session" }, id: null }, 400);
    }

    const { server } = createSession({
      config,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id: string) => {
        sessions.set(id, { transport, lastSeen: Date.now() });
        console.error(`[bark-mcp] MCP 会话 ${id} 建立（共 ${sessions.size} 个）`);
      },
      onsessionclosed: (id: string) => {
        sessions.delete(id);
        console.error(`[bark-mcp] MCP 会话 ${id} 关闭（共 ${sessions.size} 个）`);
      },
    });
    transport.onerror = (error: Error) => console.error("[bark-mcp] MCP 传输错误:", error.message);
    await server.connect(transport);
    return transport.handleRequest(req, { parsedBody: parsed });
  };

  const handler = async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const path = url.pathname;

      // MCP 端点：认证后交给 SDK 的 Web 标准传输层
      if (path === MCP_PATH) {
        if (!checkAuth(req, auth)) return unauthorized();
        if (!["GET", "POST", "DELETE"].includes(req.method)) {
          return json({ error: "Method not allowed" }, 405);
        }
        return sessionForRequest(req.headers.get("mcp-session-id"), req);
      }

      // 页面本身不需要令牌（里面没有任何密钥），API 才校验
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        return new Response(INDEX_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }

      if (!path.startsWith("/api/")) return json({ ok: false, error: "Not found" }, 404);
      if (!checkAuth(req, auth)) return unauthorized();

      try {
        if (req.method === "GET" && path === "/api/config") {
          return json({
            server: config.server,
            device_key_set: Boolean(config.deviceKey),
            device_key_masked: config.deviceKey ? mask(config.deviceKey) : "",
            keys: config.keys,
            algorithms: ALGORITHMS,
            modes: MODES,
            auth_required: Boolean(token),
            version: VERSION,
            scenarios: SCENARIO_GROUPS,
          });
        }

        if (req.method === "POST" && path === "/api/crypto/regenerate") {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const algorithm = body.algorithm;
          if (!isAlgorithm(algorithm)) return json({ ok: false, error: "未知算法" }, 400);
          config.keys[algorithm] = generateKey(ALGOS[algorithm]);
          saveKeys(config.keysFile, config.keys);
          return json({ ok: true, algorithm, key: config.keys[algorithm] });
        }

        if (req.method === "POST" && path === "/api/push") {
          const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
          if (!body) return json({ ok: false, error: "请求体必须是 JSON 对象" }, 400);

          let options2 = parsePushOptions(body);
          const scenarioKey = typeof body.scenario === "string" ? body.scenario : undefined;
          if (scenarioKey) {
            const scenario = findScenario(scenarioKey);
            if (!scenario) return json({ ok: false, error: `未知场景: ${scenarioKey}` }, 400);
            options2 = { ...scenario.payload, ...options2 };
          }

          const settings: PushSettings = {
            encrypt: body.encrypt === true,
            ...(isAlgorithm(body.algorithm) ? { algorithm: body.algorithm } : {}),
            ...(isMode(body.mode) ? { mode: body.mode } : {}),
          };

          const result = await pushNotification(options2, settings, {
            config,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          });
          return json(result);
        }

        return json({ ok: false, error: "Not found" }, 404);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[bark-mcp] /api 出错:", message);
        return json({ ok: false, error: message }, 400);
      }
  };

  const nodeServer = await serveNode(handler, host, port);

  // 清理闲置 MCP 会话，避免长跑进程内存泄漏
  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastSeen <= SESSION_TTL_MS) continue;
      sessions.delete(id);
      void session.transport.close().catch(() => undefined);
      console.error(`[bark-mcp] 回收闲置 MCP 会话 ${id}`);
    }
  }, 60_000);
  reaper.unref?.();

  return { server: nodeServer, url: `http://${host}:${nodeServer.port}` };
}

export async function runHttp(options: StartServerOptions = {}): Promise<void> {
  const config = options.config ?? loadConfig();
  const { server, url } = await startServer({ ...options, config });
  console.error(
    `[bark-mcp] v${VERSION} 已启动 ${url}\n` +
      `  游乐场   ${url}/\n` +
      `  MCP      ${url}${MCP_PATH}\n` +
      `  Bark     ${config.server}\n` +
      `  BARK_KEY ${config.deviceKey ? mask(config.deviceKey) : "未配置"}`,
  );

  const shutdown = () => {
    console.error("[bark-mcp] 正在关闭…");
    void server.stop(true).finally(() => process.exit(0));
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, shutdown);
}
