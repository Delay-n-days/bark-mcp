/**
 * MCP 层测试：直接驱动 Session，不启进程。
 */
import { describe, expect, it } from "bun:test";

import type { AppConfig } from "../src/config.ts";
import { createSession } from "../src/mcp/server.ts";

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    server: "https://api.day.app",
    deviceKey: "SERVERKEY1234567",
    keysFile: "/tmp/bark-test-keys.json",
    keys: {
      "aes-128": "1234567890123456",
      "aes-192": "123456789012345678901234",
      "aes-256": "12345678901234567890123456789012",
    },
    allowCustomKey: true,
    ...overrides,
  };
}

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

/** 直接调用 SDK 的请求处理器，绕开传输层。 */
async function callTool(
  config: AppConfig,
  name: string,
  args: Record<string, unknown>,
  fetchImpl?: typeof fetch,
): Promise<ToolResult> {
  const session = createSession({ config, ...(fetchImpl ? { fetchImpl } : {}) });
  const handler = (
    session.server as unknown as {
      _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
    }
  )._requestHandlers.get("tools/call");
  if (!handler) throw new Error("tools/call handler 未注册");
  return (await handler({ method: "tools/call", params: { name, arguments: args } })) as ToolResult;
}

async function listTools(config: AppConfig): Promise<{ name: string; description: string }[]> {
  const session = createSession({ config });
  const handler = (
    session.server as unknown as {
      _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
    }
  )._requestHandlers.get("tools/list");
  if (!handler) throw new Error("tools/list handler 未注册");
  const result = (await handler({ method: "tools/list" })) as { tools: { name: string; description: string }[] };
  return result.tools;
}

const okFetch = (captured: Record<string, unknown>[]) =>
  (async (_url: string, init: RequestInit) => {
    captured.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ code: 200, message: "success" }), { status: 200 });
  }) as unknown as typeof fetch;

describe("工具声明", () => {
  it("暴露 6 个工具", async () => {
    const tools = await listTools(testConfig());
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "bark_crypto_keys",
      "bark_encrypt",
      "bark_push",
      "bark_scenario_push",
      "bark_scenarios",
      "bark_status",
    ]);
    for (const tool of tools) expect(tool.description.length).toBeGreaterThan(10);
  });
});

describe("bark_push", () => {
  it("明文推送并回报成功", async () => {
    const captured: Record<string, unknown>[] = [];
    const result = await callTool(
      testConfig(),
      "bark_push",
      { title: "hi", body: "hello", badge: 0 },
      okFetch(captured),
    );
    expect(captured[0]).toEqual({ device_key: "SERVERKEY1234567", title: "hi", body: "hello", badge: 0 });
    expect(result.content[0]?.text).toContain("推送成功");
  });

  it("加密推送不泄露明文", async () => {
    const captured: Record<string, unknown>[] = [];
    const result = await callTool(
      testConfig(),
      "bark_push",
      { title: "secret", body: "hidden", encrypt: true, algorithm: "aes-256", mode: "gcm" },
      okFetch(captured),
    );
    const body = captured[0]!;
    expect(body.title).toBeUndefined();
    expect(body.ciphertext).toBeString();
    expect(String(body.iv)).toMatch(/^[0-9a-f]{12}$/);
    expect(result.content[0]?.text).toContain("aes-256/gcm");
  });

  it("extra 字段透传", async () => {
    const captured: Record<string, unknown>[] = [];
    await callTool(testConfig(), "bark_push", { title: "x", extra: { customField: "v" } }, okFetch(captured));
    expect(captured[0]?.customField).toBe("v");
  });

  it("空参数报错", async () => {
    await expect(callTool(testConfig(), "bark_push", {})).rejects.toThrow(/title/);
  });

  it("自定义 device_key 生效", async () => {
    const captured: Record<string, unknown>[] = [];
    await callTool(testConfig(), "bark_push", { title: "x", device_key: "MyDeviceKey9999" }, okFetch(captured));
    expect(captured[0]?.device_key).toBe("MyDeviceKey9999");
  });
});

describe("场景工具", () => {
  it("bark_scenarios 列出全部场景", async () => {
    const result = await callTool(testConfig(), "bark_scenarios", {});
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("basic");
    expect(text).toContain("encrypted");
  });

  it("bark_scenarios 支持分组过滤", async () => {
    const result = await callTool(testConfig(), "bark_scenarios", { group: "加密" });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("bark_scenario_push");
    expect(text).not.toContain("`basic`");
  });

  it("bark_scenario_push 默认加密场景走加密链路", async () => {
    const captured: Record<string, unknown>[] = [];
    await callTool(testConfig(), "bark_scenario_push", { scenario: "encrypted" }, okFetch(captured));
    expect(captured[0]?.ciphertext).toBeString();
  });

  it("bark_scenario_push 支持 overrides", async () => {
    const captured: Record<string, unknown>[] = [];
    await callTool(
      testConfig(),
      "bark_scenario_push",
      { scenario: "progress", overrides: { body: "已完成 80%" } },
      okFetch(captured),
    );
    expect(captured[0]?.body).toBe("已完成 80%");
    expect(captured[0]?.id).toBe("demo-progress");
  });

  it("未知场景报错并给出候选", async () => {
    await expect(callTool(testConfig(), "bark_scenario_push", { scenario: "nope" })).rejects.toThrow(/未知场景/);
  });
});

describe("bark_encrypt", () => {
  it("返回可解密的密文", async () => {
    const result = await callTool(testConfig(), "bark_encrypt", {
      payload: { title: "hi" },
      algorithm: "aes-128",
      mode: "cbc",
    });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("1234567890123456");
    expect(text).toContain("iv:");
    expect(text).toContain("ciphertext:");
  });

  it("空 payload 报错", async () => {
    await expect(callTool(testConfig(), "bark_encrypt", { payload: {} })).rejects.toThrow();
  });
});

describe("状态与密钥", () => {
  it("bark_status 脱敏 device key", async () => {
    const fetchImpl = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const result = await callTool(testConfig(), "bark_status", {}, fetchImpl);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("SERV…4567");
    expect(text).not.toContain("SERVERKEY1234567");
    expect(text).toContain("服务器可达: 是");
  });

  it("bark_status 报告服务器不可达", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await callTool(testConfig(), "bark_status", {}, fetchImpl);
    expect(result.content[0]?.text).toContain("服务器可达: 否");
  });

  it("bark_crypto_keys 读取密钥", async () => {
    const result = await callTool(testConfig(), "bark_crypto_keys", {});
    expect(result.content[0]?.text).toContain("1234567890123456");
  });

  it("bark_crypto_keys 可重新生成密钥并落盘", async () => {
    const keysFile = `/tmp/bark-keys-${crypto.randomUUID()}.json`;
    const config = testConfig({ keysFile });
    const result = await callTool(config, "bark_crypto_keys", { regenerate: "aes-192" });
    const text = result.content[0]?.text ?? "";
    const generated = /新密钥: (\w{24})/.exec(text)?.[1] ?? "";
    expect(generated).toHaveLength(24);
    const saved = JSON.parse(await Bun.file(keysFile).text());
    expect(saved["aes-192"]).toBe(generated);
    expect(config.keys["aes-192"]).toBe(generated);
  });
});
