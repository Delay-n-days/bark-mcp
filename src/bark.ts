/**
 * Bark HTTP 客户端 + 推送编排（明文 / 加密、单发 / 群发）。
 */
import { encryptJson } from "./crypto.ts";
import type { Algorithm, AppConfig, Mode } from "./config.ts";

/** Bark 支持的通知参数（字段与 Bark JSON API 保持一致）。 */
export interface PushOptions {
  title?: string;
  subtitle?: string;
  body?: string;
  markdown?: string;
  device_key?: string;
  device_keys?: string[];
  group?: string;
  icon?: string;
  image?: string;
  badge?: number;
  level?: string;
  volume?: number;
  call?: string;
  sound?: string;
  /** JSON 里叫 copy，TS 里用 copyText 避免与 Object.copy 混淆 */
  copy?: string;
  automaticallycopy?: string;
  url?: string;
  action?: string;
  isArchive?: string;
  ttl?: number;
  id?: string;
  delete?: string;
  /** 扩展字段：任何额外键都会透传给 Bark */
  [extra: string]: unknown;
}

export interface PushSettings {
  encrypt?: boolean;
  algorithm?: Algorithm;
  mode?: Mode;
}

export interface BarkResult {
  ok: boolean;
  encrypted: boolean;
  algorithm: Algorithm | null;
  mode: Mode | null;
  /** 加密前的明文 payload */
  plain: Record<string, unknown>;
  ciphertext: string | null;
  iv: string | null;
  /** 实际发往 Bark 的请求体（device_key 已脱敏） */
  request: Record<string, unknown>;
  /** Bark 返回的 JSON（非 JSON 时是原始字符串） */
  bark: unknown;
  raw: string;
  /** HTTP 状态码，网络失败时为 null */
  status: number | null;
  error?: string;
}

const RESERVED = new Set([
  "encrypt",
  "algorithm",
  "mode",
  "device_key",
  "device_keys",
]);

export function mask(value: string): string {
  return value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : "已隐藏";
}

function maskBody(body: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...body };
  if (typeof masked.device_key === "string") masked.device_key = mask(masked.device_key);
  if (Array.isArray(masked.device_keys)) {
    masked.device_keys = masked.device_keys.map((item) => (typeof item === "string" ? mask(item) : item));
  }
  return masked;
}

/** 去掉控制字段、空值，得到真正要发给 Bark 的内容。 */
export function buildPayload(options: PushOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (RESERVED.has(key)) continue;
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

/** 判定 Bark 是否接受：顶层 code，或批量模式的 data[].code。 */
export function isSuccess(bark: unknown): boolean {
  if (!bark || typeof bark !== "object") return false;
  const body = bark as Record<string, unknown>;
  if (typeof body.code === "number") return body.code === 200;
  if (Array.isArray(body.data)) {
    return body.data.every(
      (item) => item && typeof item === "object" && (item as Record<string, unknown>).code === 200,
    );
  }
  return false;
}

export interface CallBarkOptions {
  server: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function callBark(
  body: Record<string, unknown>,
  options: CallBarkOptions,
): Promise<{ bark: unknown; raw: string; status: number | null; error?: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.server.replace(/\/+$/, "")}/push`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...options.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { bark: null, raw: "", status: null, error: `连接 Bark 服务器失败: ${reason}` };
  }

  const raw = await response.text();
  let bark: unknown = raw;
  try {
    bark = raw ? JSON.parse(raw) : null;
  } catch {
    /* 保留原始文本 */
  }
  return {
    bark,
    raw,
    status: response.status,
    ...(response.status >= 400 ? { error: `Bark 返回 HTTP ${response.status}` } : {}),
  };
}

export interface PushDeps {
  config: AppConfig;
  fetchImpl?: typeof fetch;
  /** 覆盖默认目标（MCP 场景下通常是调用方传入的 key） */
  deviceKeys?: string[];
}

/**
 * 执行一次推送：解析目标 → 可选加密 → 调 Bark → 汇总结果。
 */
export async function pushNotification(
  options: PushOptions,
  settings: PushSettings,
  deps: PushDeps,
): Promise<BarkResult> {
  const { config } = deps;
  const encrypt = settings.encrypt === true;
  const algorithm: Algorithm = settings.algorithm ?? "aes-128";
  const mode: Mode = settings.mode ?? "cbc";

  if (encrypt && !Object.hasOwn(config.keys, algorithm)) {
    throw new Error(`未知算法: ${algorithm}`);
  }
  if (encrypt && !["cbc", "ecb", "gcm"].includes(mode)) {
    throw new Error(`未知加密模式: ${mode}`);
  }

  const payload = buildPayload(options);

  // 目标设备：显式传入的 device_keys > 单次 tools 参数 > .env 的 BARK_KEY
  let keys = (deps.deviceKeys ?? options.device_keys ?? [])
    .map((key) => key.trim())
    .filter(Boolean);
  if (keys.length === 0 && typeof options.device_key === "string") {
    keys = [options.device_key.trim()].filter(Boolean);
  }
  if (keys.length === 0 && config.deviceKey) keys = [config.deviceKey];
  if (keys.length === 0) {
    throw new Error("没有可用的 device_key：请在 .env 设置 BARK_KEY，或在调用时传入 device_key");
  }
  if (!config.allowCustomKey && config.deviceKey && !keys.every((key) => key === config.deviceKey)) {
    throw new Error("该服务端已禁止自定义 device_key（BARK_ALLOW_CUSTOM_KEY=0）");
  }

  const request: Record<string, unknown> = keys.length > 1 ? { device_keys: keys } : { device_key: keys[0] };
  let ciphertext: string | null = null;
  let iv: string | null = null;

  if (encrypt) {
    const encrypted = encryptJson(payload, config.keys[algorithm], algorithm, mode);
    ciphertext = encrypted.ciphertext;
    iv = encrypted.iv || null;
    request.ciphertext = ciphertext;
    if (iv) request.iv = iv;
    // id / delete 是主 App 在 APNs 明文里读取的，静默删除不经过解密扩展
    if (typeof payload.id === "string") request.id = payload.id;
    if (payload.delete === "1") request.delete = "1";
  } else {
    Object.assign(request, payload);
  }

  const result = await callBark(request, {
    server: config.server,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  const ok = isSuccess(result.bark);
  const out: BarkResult = {
    ok,
    encrypted: encrypt,
    algorithm: encrypt ? algorithm : null,
    mode: encrypt ? mode : null,
    plain: payload,
    ciphertext,
    iv,
    request: maskBody(request),
    bark: result.bark,
    raw: result.raw,
    status: result.status,
  };
  if (!ok && result.error) out.error = result.error;
  if (!ok && !result.error) {
    const message =
      result.bark && typeof result.bark === "object" && typeof (result.bark as { message?: unknown }).message === "string"
        ? String((result.bark as { message?: unknown }).message)
        : result.status !== null
          ? `Bark 返回 HTTP ${result.status}`
          : "Bark 返回失败";
    out.error = message;
  }
  return out;
}
