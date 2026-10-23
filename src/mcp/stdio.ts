#!/usr/bin/env bun
/**
 * stdio 入口：给 Claude Code / Codex / 任意 MCP 客户端用。
 *
 * 注意：stdout 是 JSON-RPC 通道，日志一律走 stderr。
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "../config.ts";
import { createSession, VERSION } from "./server.ts";

export async function runStdio(): Promise<void> {
  const config = loadConfig();
  const { server } = createSession({ config });
  await server.connect(new StdioServerTransport());
  console.error(
    `[bark-mcp] v${VERSION} (stdio) -> ${config.server} ` +
      `[BARK_KEY: ${config.deviceKey ? "已配置" : "未配置"}，自定义 device_key: ${config.allowCustomKey ? "允许" : "禁止"}]`,
  );

  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, shutdown);
}

if (import.meta.main) {
  runStdio().catch((error: unknown) => {
    console.error("[bark-mcp] 启动失败:", error);
    process.exit(1);
  });
}
