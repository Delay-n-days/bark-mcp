/**
 * MCP 服务（stdio / streamable HTTP 共用）。
 *
 * 工具划分原则：
 * - `bark_push` 是主入口，一个工具覆盖 Bark 全部参数；
 * - `bark_scenarios` / `bark_scenario_push` 把 UI 里的场景库暴露给模型，
 *   模型不用记参数也能发出「进度条 / 验证码 / 循环响铃」这类效果；
 * - `bark_encrypt` 只加密不发送，方便模型自查加密结果；
 * - `bark_status` / `bark_crypto_keys` 负责自检与配置同步。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import {
  mask,
  pushNotification,
  type BarkResult,
  type PushOptions,
  type PushSettings,
} from "../bark.ts";
import {
  ALGOS,
  ALGORITHMS,
  MODES,
  generateKey,
  isAlgorithm,
  isMode,
  saveKeys,
  type Algorithm,
  type AppConfig,
  type Mode,
} from "../config.ts";
import { encryptJson } from "../crypto.ts";
import { SCENARIOS, SCENARIO_GROUPS, findScenario } from "../scenarios.ts";

export const VERSION = "1.0.0";
export const SERVER_NAME = "bark";

const PUSH_PROPERTIES = {
  title: { type: "string", description: "通知标题" },
  subtitle: { type: "string", description: "副标题" },
  body: { type: "string", description: "正文（与 markdown 二选一，markdown 优先）" },
  markdown: { type: "string", description: "Markdown 正文，Bark 会渲染并忽略 body" },
  group: { type: "string", description: "通知分组名，同名消息会归到一组" },
  icon: { type: "string", description: "通知图标 URL（iOS 15+）" },
  image: { type: "string", description: "通知大图 URL，展开可见" },
  badge: { type: "number", description: "App 角标数字；0 表示清除角标" },
  level: {
    type: "string",
    enum: ["active", "timeSensitive", "passive", "critical"],
    description: "通知级别；critical 会忽略静音（需 App 授权）",
  },
  volume: { type: "number", description: "critical 通知的音量 0-10" },
  call: { type: "string", enum: ["1"], description: '传 "1" 让铃声循环 30 秒' },
  sound: { type: "string", description: "铃声名，例如 birdsong / alarm / minuet" },
  copy: { type: "string", description: "通知里可一键复制的内容（如验证码）" },
  automaticallycopy: { type: "string", enum: ["1"], description: '传 "1" 自动复制 copy 内容' },
  url: { type: "string", description: "点击通知跳转的 URL" },
  action: {
    type: "string",
    enum: ["none", "alert"],
    description: 'none 只打开 App，alert 弹出操作菜单',
  },
  isArchive: { type: "string", enum: ["0", "1"], description: '"0" 不写入历史记录' },
  ttl: { type: "number", description: "消息存活秒数，到期自动从通知中心删除" },
  id: { type: "string", description: "消息 ID，相同 id 会更新同一条通知（做进度条）" },
  delete: { type: "string", enum: ["1"], description: '配合同 id 传 "1" 删除该通知' },
  device_key: { type: "string", description: "单个设备 key；默认用服务端的 BARK_KEY" },
  device_keys: {
    type: "array",
    items: { type: "string" },
    description: "批量推送多个设备 key（优先于 device_key）",
  },
  encrypt: { type: "boolean", description: "是否用 Bark 加密方案发送（默认 false）" },
  algorithm: {
    type: "string",
    enum: ALGORITHMS,
    description: "加密算法，需与 Bark App 设置一致，默认 aes-128",
  },
  mode: { type: "string", enum: MODES, description: "加密模式，需与 App 一致，默认 cbc" },
  extra: {
    type: "object",
    description: "额外透传给 Bark 的字段（覆盖同名参数），unknown 字段也能用",
  },
} as const;

const PUSH_REQUIRED_HINT =
  "至少提供 title / body / markdown 之一，或用 bark_scenario_push 直接发预设场景。";

const tools = [
  {
    name: "bark_push",
    description:
      "通过 Bark 给 iPhone 推送通知，支持标题/正文/Markdown/分组/图标/大图/角标/级别/铃声/自动复制/跳转/定时删除/进度更新，并可选用 Bark 官方 AES 加密。默认使用服务端配置的 BARK_KEY。",
    inputSchema: {
      type: "object",
      properties: PUSH_PROPERTIES,
      additionalProperties: false,
    },
  },
  {
    name: "bark_scenarios",
    description:
      "列出内置的 Bark 推送场景（基础推送、Markdown、分组、角标、时效性、循环响铃、验证码复制、进度更新、加密等），可把 key 交给 bark_scenario_push 直接发送。",
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string", description: "只返回该分组（内容 / 展示与分组 / 提醒与铃声 / 复制与跳转 / 保存与管理 / 加密）" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bark_scenario_push",
    description:
      "发送内置场景的消息，可在场景默认值上覆盖标题/正文等字段（例如把「下载进度」场景改成 80%）。",
    inputSchema: {
      type: "object",
      properties: {
        scenario: { type: "string", description: "场景 key，见 bark_scenarios，例如 basic / markdown / progress / encrypted" },
        overrides: {
          type: "object",
          description: "覆盖场景默认 payload 的字段，例如 {\"body\":\"已完成 80%\"}",
        },
        device_key: { type: "string", description: "可选：目标设备 key" },
        device_keys: { type: "array", items: { type: "string" }, description: "可选：批量目标设备" },
        encrypt: { type: "boolean", description: "可选：覆盖场景的加密开关" },
        algorithm: { type: "string", enum: ALGORITHMS, description: "可选：加密算法" },
        mode: { type: "string", enum: MODES, description: "可选：加密模式" },
      },
      required: ["scenario"],
      additionalProperties: false,
    },
  },
  {
    name: "bark_encrypt",
    description:
      "只做 Bark 加密、不发推送：返回 ciphertext（GCM 已把认证标签拼在尾部）和 iv，便于排查 App 端解密失败。",
    inputSchema: {
      type: "object",
      properties: {
        payload: {
          type: "object",
          description: "要加密的 Bark payload，例如 {\"title\":\"hi\",\"body\":\"test\"}",
        },
        algorithm: { type: "string", enum: ALGORITHMS, description: "默认 aes-128" },
        mode: { type: "string", enum: MODES, description: "默认 cbc" },
      },
      required: ["payload"],
      additionalProperties: false,
    },
  },
  {
    name: "bark_status",
    description:
      "查看 Bark 服务端配置：服务器地址、是否已配置 BARK_KEY（脱敏）、可用算法/模式、以及 Bark 服务器是否可达。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bark_crypto_keys",
    description:
      "查看当前加密密钥（需与 Bark App「推送加密」里填写的一致），可指定算法重新生成一把新 key。",
    inputSchema: {
      type: "object",
      properties: {
        regenerate: {
          type: "string",
          enum: ALGORITHMS,
          description: "重新生成该算法的密钥并持久化；不传则只读取",
        },
      },
      additionalProperties: false,
    },
  },
] as const;

export interface BarkSession {
  server: Server;
  config: AppConfig;
}

export interface CreateSessionOptions {
  config: AppConfig;
  fetchImpl?: typeof fetch;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  return out.length > 0 ? out : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 把 MCP 参数翻成 Bark payload，忽略 undefined。 */
function toPushOptions(args: Record<string, unknown>): PushOptions {
  const options: PushOptions = {};
  const keys: (keyof PushOptions)[] = [
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
    const value = optionalString(args[key]);
    if (value !== undefined) options[key] = value;
  }
  const badge = optionalNumber(args.badge);
  if (badge !== undefined) options.badge = badge;
  const volume = optionalNumber(args.volume);
  if (volume !== undefined) options.volume = volume;
  const ttl = optionalNumber(args.ttl);
  if (ttl !== undefined) options.ttl = ttl;
  const deviceKeys = stringArray(args.device_keys);
  if (deviceKeys) options.device_keys = deviceKeys;
  return options;
}

function settingsFrom(args: Record<string, unknown>, fallback?: PushSettings): PushSettings {
  const algorithm = isAlgorithm(args.algorithm) ? args.algorithm : fallback?.algorithm;
  const mode = isMode(args.mode) ? args.mode : fallback?.mode;
  const encrypt = typeof args.encrypt === "boolean" ? args.encrypt : fallback?.encrypt;
  return {
    ...(encrypt !== undefined ? { encrypt } : {}),
    ...(algorithm ? { algorithm } : {}),
    ...(mode ? { mode } : {}),
  };
}

function summarize(result: BarkResult): string {
  const target = Array.isArray(result.request.device_keys)
    ? `${(result.request.device_keys as string[]).length} 个设备`
    : String(result.request.device_key ?? "—");
  const lines = [
    result.ok ? "✅ 推送成功" : `❌ 推送失败${result.error ? `：${result.error}` : ""}`,
    `目标: ${target}`,
    `加密: ${result.encrypted ? `${result.algorithm}/${result.mode}` : "明文"}`,
    result.status !== null ? `HTTP: ${result.status}` : null,
    result.ciphertext ? `ciphertext: ${result.ciphertext}` : null,
    result.iv ? `iv: ${result.iv}` : null,
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

function readableBark(bark: unknown): string {
  if (bark === null || bark === undefined) return "—";
  return typeof bark === "string" ? bark : JSON.stringify(bark, null, 2);
}

function formatScenarioList(groupFilter?: string): string {
  const groups = groupFilter
    ? SCENARIO_GROUPS.filter((group) => group.name.includes(groupFilter.trim()))
    : SCENARIO_GROUPS;
  if (groups.length === 0) return `没有匹配「${groupFilter}」的场景分组。`;
  const lines = ["# Bark 内置场景", ""];
  for (const group of groups) {
    lines.push(`## ${group.name}`);
    for (const item of group.items) {
      const encrypted = item.encrypt ? "（默认加密）" : "";
      lines.push(`- \`${item.key}\` ${item.icon} ${item.label}${encrypted} — ${item.desc}`);
    }
    lines.push("");
  }
  lines.push("用 bark_scenario_push({ scenario: \"<key>\" }) 直接发送。");
  return lines.join("\n");
}

export function createSession(options: CreateSessionOptions): BarkSession {
  const { config } = options;

  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Bark 是 iOS 推送工具。给用户手机发通知请调用 bark_push；不确定参数时先 bark_scenarios 看预设。默认目标是服务端 .env 里的 BARK_KEY，只有明确需要时才传 device_key。",
    },
  );

  const push = async (payload: PushOptions, settings: PushSettings, deviceKeys?: string[]): Promise<BarkResult> =>
    pushNotification(payload, settings, {
      config,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(deviceKeys ? { deviceKeys } : {}),
    });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools as unknown as { name: string; description: string; inputSchema: object }[],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = asObject(request.params.arguments ?? {});

    try {
      switch (request.params.name) {
        case "bark_push": {
          const payload = toPushOptions(args);
          const extra = asObject(args.extra);
          Object.assign(payload, extra);
          if (
            payload.title === undefined &&
            payload.body === undefined &&
            payload.markdown === undefined &&
            payload.id === undefined
          ) {
            throw new McpError(ErrorCode.InvalidParams, PUSH_REQUIRED_HINT);
          }
          const result = await push(payload, settingsFrom(args));
          return textResult(
            [
              summarize(result),
              "",
              "## 请求（device_key 已脱敏）",
              "```json",
              JSON.stringify(result.request, null, 2),
              "```",
              "",
              "## Bark 返回",
              "```json",
              readableBark(result.bark),
              "```",
            ].join("\n"),
          );
        }

        case "bark_scenarios": {
          const group = optionalString(args.group);
          return textResult(formatScenarioList(group));
        }

        case "bark_scenario_push": {
          const key = optionalString(args.scenario);
          if (!key) throw new McpError(ErrorCode.InvalidParams, "scenario is required");
          const scenario = findScenario(key);
          if (!scenario) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `未知场景: ${key}。可用: ${SCENARIOS.map((item) => item.key).join(", ")}`,
            );
          }
          const payload: PushOptions = { ...scenario.payload, ...asObject(args.overrides) };
          const settings = settingsFrom(args, { encrypt: scenario.encrypt === true });
          const deviceKeys = stringArray(args.device_keys);
          if (optionalString(args.device_key)) payload.device_key = String(args.device_key);
          const result = await push(payload, settings, deviceKeys);
          return textResult(
            [
              `场景: ${scenario.icon} ${scenario.label} (${scenario.key})`,
              summarize(result),
              "",
              "## 实际 payload",
              "```json",
              JSON.stringify(result.plain, null, 2),
              "```",
              "",
              "## Bark 返回",
              "```json",
              readableBark(result.bark),
              "```",
            ].join("\n"),
          );
        }

        case "bark_encrypt": {
          const payload = asObject(args.payload);
          if (Object.keys(payload).length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "payload must be a non-empty object");
          }
          const algorithm: Algorithm = isAlgorithm(args.algorithm) ? args.algorithm : "aes-128";
          const mode: Mode = isMode(args.mode) ? args.mode : "cbc";
          const { ciphertext, iv } = encryptJson(payload, config.keys[algorithm], algorithm, mode);
          return textResult(
            [
              `算法: ${algorithm}/${mode}`,
              `key: ${config.keys[algorithm]}`,
              `iv: ${iv || "（ECB 无 IV）"}`,
              "",
              "ciphertext:",
              ciphertext,
              "",
              "## 明文",
              "```json",
              JSON.stringify(payload, null, 2),
              "```",
            ].join("\n"),
          );
        }

        case "bark_status": {
          let reachable: boolean | null = null;
          let pingError: string | undefined;
          try {
            const response = await (options.fetchImpl ?? fetch)(
              `${config.server}/ping`,
              { signal: AbortSignal.timeout(8_000) },
            );
            reachable = response.ok;
            if (!response.ok) pingError = `HTTP ${response.status}`;
          } catch (error) {
            reachable = false;
            pingError = errorMessage(error);
          }
          return textResult(
            [
              "# Bark 服务状态",
              `服务器: ${config.server}`,
              `服务器可达: ${reachable ? "是" : `否${pingError ? `（${pingError}）` : ""}`}`,
              `BARK_KEY: ${config.deviceKey ? mask(config.deviceKey) : "未配置"}`,
              `允许自定义 device_key: ${config.allowCustomKey ? "是" : "否"}`,
              `密钥文件: ${config.keysFile}`,
              `算法: ${ALGORITHMS.join(", ")}`,
              `模式: ${MODES.join(", ")}`,
              "",
              "## 当前密钥（需与 App 内设置一致）",
              "```json",
              JSON.stringify(config.keys, null, 2),
              "```",
            ].join("\n"),
          );
        }

        case "bark_crypto_keys": {
          const algorithm = args.regenerate;
          if (algorithm !== undefined) {
            if (!isAlgorithm(algorithm)) {
              throw new McpError(ErrorCode.InvalidParams, `未知算法: ${String(algorithm)}`);
            }
            config.keys[algorithm] = generateKey(ALGOS[algorithm]);
            saveKeys(config.keysFile, config.keys);
            return textResult(
              `已为 ${algorithm} 生成新密钥: ${config.keys[algorithm]}\n请同步更新 Bark App 的「推送加密」设置。`,
            );
          }
          return textResult(
            [
              "# 加密密钥",
              `文件: ${config.keysFile}`,
              "",
              "```json",
              JSON.stringify(config.keys, null, 2),
              "```",
              "",
              "把对应算法的 KEY、算法、模式填进 Bark App → 首页 →「推送加密」，服务端 encrypt=true 时才能解密。",
            ].join("\n"),
          );
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
      }
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(ErrorCode.InternalError, errorMessage(error));
    }
  });

  return { server, config };
}
