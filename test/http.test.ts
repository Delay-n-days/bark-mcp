/**
 * HTTP 层测试：真起一个 server（随机端口），验证认证、API 与 MCP 端点。
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { AppConfig } from "../src/config.ts";
import { startServer } from "../src/http.ts";

const TOKEN = "TestBarkKey1234567";

function testConfig(): AppConfig {
  return {
    server: "https://api.day.app",
    deviceKey: TOKEN,
    keysFile: `/tmp/bark-http-keys-${crypto.randomUUID()}.json`,
    keys: {
      "aes-128": "1234567890123456",
      "aes-192": "123456789012345678901234",
      "aes-256": "12345678901234567890123456789012",
    },
    allowCustomKey: true,
  };
}

const captured: Record<string, unknown>[] = [];
const fakeFetch = (async (_url: string, init: RequestInit) => {
  captured.push(JSON.parse(String(init.body)));
  return new Response(JSON.stringify({ code: 200, message: "success" }), { status: 200 });
}) as unknown as typeof fetch;

let base = "";
let stop: () => Promise<void> = async () => {};

beforeAll(async () => {
  const { server, url } = startServer({
    config: testConfig(),
    host: "127.0.0.1",
    port: 0,
    requireAuth: true,
    fetchImpl: fakeFetch,
  });
  base = url;
  stop = async () => {
    await server.stop(true);
  };
});

afterAll(async () => {
  await stop();
});

const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

describe("页面", () => {
  it("GET / 返回 HTML 且不需要令牌", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Bark 推送游乐场");
  });
});

describe("认证", () => {
  it("无令牌访问 /api/config 返回 401", async () => {
    const res = await fetch(`${base}/api/config`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("错误令牌返回 401", async () => {
    const res = await fetch(`${base}/api/config`, { headers: { Authorization: "Bearer wrong" } });
    expect(res.status).toBe(401);
  });

  it("支持 x-bark-key 头", async () => {
    const res = await fetch(`${base}/api/config`, { headers: { "x-bark-key": TOKEN } });
    expect(res.status).toBe(200);
  });
});

describe("/api/config", () => {
  it("返回脱敏配置与场景", async () => {
    const res = await fetch(`${base}/api/config`, { headers: auth });
    const data = await res.json();
    expect(data.server).toBe("https://api.day.app");
    expect(data.device_key_masked).toBe("Test…4567");
    expect(data.algorithms).toEqual(["aes-128", "aes-192", "aes-256"]);
    expect(data.modes).toEqual(["cbc", "ecb", "gcm"]);
    expect(data.auth_required).toBe(true);
    expect(data.scenarios.length).toBeGreaterThan(3);
    expect(JSON.stringify(data)).not.toContain(TOKEN);
  });
});

describe("/api/push", () => {
  it("明文推送", async () => {
    captured.length = 0;
    const res = await fetch(`${base}/api/push`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ title: "hi", body: "hello" }),
    });
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(captured[0]).toEqual({ device_key: TOKEN, title: "hi", body: "hello" });
    expect(data.request.device_key).toBe("Test…4567");
  });

  it("按场景 key 发送", async () => {
    captured.length = 0;
    const res = await fetch(`${base}/api/push`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ scenario: "badge", body: "覆盖正文" }),
    });
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(captured[0]?.badge).toBe(3);
    expect(captured[0]?.body).toBe("覆盖正文");
    // scenario 是控制字段，不能进 payload
    expect(captured[0]?.scenario).toBeUndefined();
  });

  it("加密推送", async () => {
    captured.length = 0;
    const res = await fetch(`${base}/api/push`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ title: "secret", encrypt: true, algorithm: "aes-128", mode: "ecb" }),
    });
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.encrypted).toBe(true);
    expect(data.iv).toBeNull();
    expect(captured[0]?.ciphertext).toBeString();
    expect(captured[0]?.title).toBeUndefined();
  });

  it("未知场景返回 400", async () => {
    const res = await fetch(`${base}/api/push`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ scenario: "nope" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("/api/crypto/regenerate", () => {
  it("生成新密钥", async () => {
    const res = await fetch(`${base}/api/crypto/regenerate`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ algorithm: "aes-256" }),
    });
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.key).toHaveLength(32);
  });

  it("未知算法返回 400", async () => {
    const res = await fetch(`${base}/api/crypto/regenerate`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ algorithm: "rot13" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("/mcp", () => {
  const rpc = (method: string, params: unknown, id = 1) =>
    JSON.stringify({ jsonrpc: "2.0", id, method, params });

  it("无令牌 401", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: rpc("initialize", {}),
    });
    expect(res.status).toBe(401);
  });

  it("完成 initialize → tools/list → tools/call", async () => {
    const headers = {
      ...auth,
      Accept: "application/json, text/event-stream",
    };
    const initRes = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeString();
    const body = await initRes.text();
    expect(body).toContain('"name":"bark"');

    const sessionHeaders = { ...headers, "mcp-session-id": sessionId! };

    const listRes = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: sessionHeaders,
      body: rpc("tools/list", {}, 2),
    });
    const listText = await listRes.text();
    expect(listText).toContain("bark_push");
    expect(listText).toContain("bark_scenario_push");

    captured.length = 0;
    const callRes = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: sessionHeaders,
      body: rpc(
        "tools/call",
        { name: "bark_push", arguments: { title: "from-mcp", body: "hello" } },
        3,
      ),
    });
    const callText = await callRes.text();
    expect(callText).toContain("推送成功");
    expect(captured[0]?.title).toBe("from-mcp");
  });

  it("未知会话返回 404", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...auth, Accept: "application/json, text/event-stream", "mcp-session-id": "nope" },
      body: rpc("tools/list", {}),
    });
    expect(res.status).toBe(404);
  });
});
