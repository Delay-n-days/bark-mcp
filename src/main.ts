#!/usr/bin/env bun
/**
 * 单文件入口。编译后只有 dist/bark-mcp.js 一个文件。
 *
 * 用法：
 *   bun dist/bark-mcp.js              # 启动 Web 游乐场 + Streamable HTTP MCP
 *   bun dist/bark-mcp.js mcp          # stdio MCP（给 Claude Code / Codex 等）
 *   bun dist/bark-mcp.js push --title hi --body hello
 *   bun dist/bark-mcp.js key          # 打印当前密钥
 *   bun dist/bark-mcp.js --help
 */
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
import { runHttp } from "./http.ts";
import { runStdio } from "./mcp/stdio.ts";
import { VERSION } from "./mcp/server.ts";
import { SCENARIO_GROUPS, findScenario } from "./scenarios.ts";

const HELP = `bark-mcp v${VERSION} — Bark 推送测试台 + MCP 服务

用法:
  bark-mcp [serve]                 启动游乐场 + MCP HTTP 服务 (默认 :8787)
  bark-mcp mcp                     stdio MCP，供 Claude Code / Codex 等客户端使用
  bark-mcp push [参数...]           命令行直接发一条推送
  bark-mcp scenarios               列出内置场景
  bark-mcp key [--regen <algo>]    查看 / 重新生成加密密钥
  bark-mcp --help | --version

push 参数:
  --title --subtitle --body --markdown --group --icon --image
  --badge <n> --level <active|timeSensitive|passive|critical>
  --volume <0-10> --call 1 --sound <name> --copy <text> --automaticallycopy 1
  --url <url> --action <none|alert> --isArchive <0|1> --ttl <秒>
  --id <id> --delete 1 --device-key <key> --device-keys k1,k2
  --encrypt --algorithm <${ALGORITHMS.join("|")}> --mode <${MODES.join("|")}>
  --scenario <key>        使用内置场景作为基础
  --json '{"title":"hi"}' 直接给 JSON（与其它参数合并）

环境变量:
  BARK_KEY       默认设备 key（同时作为 HTTP 服务的 bearer token）
  BARK_SERVER    默认 https://api.day.app
  BARK_HOST/BARK_PORT      服务监听地址，默认 127.0.0.1:8787
  BARK_REQUIRE_AUTH=1      回环地址也强制校验 token
  BARK_ALLOW_CUSTOM_KEY=0  禁止调用方自带 device_key
  BARK_KEYS_FILE           加密密钥文件，默认 ./crypto_keys.json

也可以用 .env 文件提供以上变量（已存在的环境变量优先）。`;

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [maybeCommand, ...rest] = argv;
  const commands = new Set(["serve", "mcp", "push", "scenarios", "key", "help"]);
  const command = maybeCommand && commands.has(maybeCommand) ? maybeCommand : "serve";
  const args = maybeCommand && commands.has(maybeCommand) ? rest : argv;

  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token || !token.startsWith("--")) continue;
    const name = token.slice(2);
    if (name === "help" || name === "version" || name === "encrypt") {
      flags[name] = true;
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { command, flags };
}

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function flagNumber(flags: Record<string, string | boolean>, name: string): number | undefined {
  const raw = flagString(flags, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionsFromFlags(flags: Record<string, string | boolean>): PushOptions {
  const options: PushOptions = {};
  // PushOptions 有索引签名，keyof 会含 number，这里固定成 string[]
  const keys: string[] = [
    "title",
    "subtitle",
    "body",
    "markdown",
    "group",
    "icon",
    "image",
    "level",
    "call",
    "sound",
    "copy",
    "automaticallycopy",
    "url",
    "action",
    "isArchive",
    "id",
    "delete",
    "device_key",
  ];
  for (const key of keys) {
    // --device-key => device_key
    const flagName = key.replace(/_/g, "-");
    const value = flagString(flags, flagName);
    if (value !== undefined) options[key] = value;
  }
  const badge = flagNumber(flags, "badge");
  if (badge !== undefined) options.badge = badge;
  const volume = flagNumber(flags, "volume");
  if (volume !== undefined) options.volume = volume;
  const ttl = flagNumber(flags, "ttl");
  if (ttl !== undefined) options.ttl = ttl;

  const deviceKeys = flagString(flags, "device-keys");
  if (deviceKeys) {
    options.device_keys = deviceKeys.split(",").map((key) => key.trim()).filter(Boolean);
  }

  const json = flagString(flags, "json");
  if (json) {
    try {
      const parsed: unknown = JSON.parse(json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        Object.assign(options, parsed as Record<string, unknown>);
      }
    } catch {
      throw new Error("--json 不是合法 JSON");
    }
  }
  return options;
}

function settingsFromFlags(flags: Record<string, string | boolean>): PushSettings {
  const algorithm = flagString(flags, "algorithm");
  const mode = flagString(flags, "mode");
  if (algorithm !== undefined && !isAlgorithm(algorithm)) throw new Error(`未知算法: ${algorithm}`);
  if (mode !== undefined && !isMode(mode)) throw new Error(`未知加密模式: ${mode}`);
  return {
    encrypt: flags.encrypt === true,
    ...(algorithm && isAlgorithm(algorithm) ? { algorithm } : {}),
    ...(mode && isMode(mode) ? { mode } : {}),
  };
}

async function commandPush(flags: Record<string, string | boolean>, config: AppConfig): Promise<number> {
  const scenarioKey = flagString(flags, "scenario");
  let options = optionsFromFlags(flags);
  if (scenarioKey) {
    const scenario = findScenario(scenarioKey);
    if (!scenario) {
      console.error(`未知场景: ${scenarioKey}\n可用: ${SCENARIO_GROUPS.flatMap((g) => g.items.map((i) => i.key)).join(", ")}`);
      return 2;
    }
    options = { ...scenario.payload, ...options };
    if (flags.encrypt === undefined && scenario.encrypt) flags.encrypt = true;
  }

  if (
    options.title === undefined &&
    options.body === undefined &&
    options.markdown === undefined &&
    options.id === undefined
  ) {
    console.error("缺少内容：至少给 --title / --body / --markdown 之一，或 --scenario <key>。用 --help 看全部参数。");
    return 2;
  }

  const result = await pushNotification(options, settingsFromFlags(flags), { config });
  if (result.ok) {
    console.log(`✅ 已推送（${result.encrypted ? `${result.algorithm}/${result.mode}` : "明文"}）`);
    if (typeof result.bark === "object" && result.bark !== null) {
      const message = (result.bark as { message?: unknown }).message;
      if (typeof message === "string") console.log(`   ${message}`);
    }
    return 0;
  }
  console.error(`❌ 推送失败: ${result.error ?? "未知错误"}`);
  if (result.raw) console.error(result.raw.slice(0, 600));
  return 1;
}

function commandScenarios(): number {
  for (const group of SCENARIO_GROUPS) {
    console.log(`\n${group.name}`);
    for (const item of group.items) {
      console.log(`  ${item.key.padEnd(14)} ${item.icon} ${item.label}${item.encrypt ? "（加密）" : ""} — ${item.desc}`);
    }
  }
  console.log("\n用法: bark-mcp push --scenario basic");
  return 0;
}

function commandKey(flags: Record<string, string | boolean>, config: AppConfig): number {
  const regen = flagString(flags, "regen");
  if (regen !== undefined) {
    if (!isAlgorithm(regen)) {
      console.error(`未知算法: ${regen}`);
      return 2;
    }
    config.keys[regen] = generateKey(ALGOS[regen]);
    saveKeys(config.keysFile, config.keys);
    console.log(`已为 ${regen} 生成新密钥: ${config.keys[regen]}`);
    console.log("请同步更新 Bark App 的「推送加密」设置。");
    return 0;
  }
  console.log(`密钥文件: ${config.keysFile}`);
  console.log(JSON.stringify(config.keys, null, 2));
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { command, flags } = parseArgs(argv);

  if (flags.version) {
    console.log(`bark-mcp v${VERSION}`);
    return 0;
  }

  if (flags.help || command === "help") {
    console.log(HELP);
    return 0;
  }

  if (command === "mcp") {
    await runStdio();
    return 0;
  }

  const config = loadConfig();

  switch (command) {
    case "push":
      return commandPush(flags, config);
    case "scenarios":
      return commandScenarios();
    case "key":
      return commandKey(flags, config);
    default: {
      const port = flagNumber(flags, "port");
      if (port !== undefined) process.env.BARK_PORT = String(port);
      const host = flagString(flags, "host");
      if (host) process.env.BARK_HOST = host;
      await runHttp({ config });
      return 0;
    }
  }
}

if (import.meta.main) {
  try {
    const code = await main();
    if (code !== 0) process.exit(code);
  } catch (error) {
    console.error("bark-mcp 出错:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
