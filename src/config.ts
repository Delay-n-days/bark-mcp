/**
 * 运行时配置：.env 加载、Bark 服务器、device key、本地加密密钥。
 *
 * 单文件编译后没有源码目录，所有路径都相对于「当前工作目录」解析，
 * 这样把 dist/bark-mcp.js 丢到任何地方都能用。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ALGOS = { "aes-128": 16, "aes-192": 24, "aes-256": 32 } as const;
export type Algorithm = keyof typeof ALGOS;
export const ALGORITHMS = Object.keys(ALGOS) as Algorithm[];

export const MODES = ["cbc", "ecb", "gcm"] as const;
export type Mode = (typeof MODES)[number];

export type CryptoKeys = Record<Algorithm, string>;

export const DEFAULT_SERVER = "https://api.day.app";
export const KEYS_FILE_NAME = "crypto_keys.json";

/**
 * 写死的默认加密密钥。
 *
 * 用途：单文件产物丢到任何机器上，不需要 `crypto_keys.json` 也能和手机 App
 * 里配置的 KEY 对上。要在 App 里换 key 就改这里重新构建，或设置
 * `BARK_KEYS_FILE` 指向自己的密钥文件（文件优先）。
 */
export const DEFAULT_KEYS: CryptoKeys = {
  "aes-128": "YChh4ziPE1eeaFZU",
  "aes-192": "0mLAQ5oJmqdVUWajtjVEAy4K",
  "aes-256": "K9tq3DK7MbidKqRUoJeJdvcxpOKHeFDX",
};

export const isAlgorithm = (v: unknown): v is Algorithm =>
  typeof v === "string" && Object.hasOwn(ALGOS, v);
export const isMode = (v: unknown): v is Mode =>
  typeof v === "string" && (MODES as readonly string[]).includes(v);

/** 依次尝试的 .env 位置：cwd → 可执行文件/打包文件所在目录。 */
function envFileCandidates(): string[] {
  const dirs = new Set<string>([process.cwd()]);
  try {
    dirs.add(dirname(process.execPath));
  } catch {
    /* 某些运行时没有 execPath，忽略 */
  }
  try {
    if (import.meta.url.startsWith("file:")) {
      dirs.add(dirname(fileURLToPath(import.meta.url)));
    }
  } catch {
    /* 单文件编译环境下可能不可用 */
  }
  return [...dirs].map((dir) => resolve(dir, ".env"));
}

/**
 * 极简 .env 解析（与 python 版行为一致）：
 * 已存在的环境变量优先，不会覆盖。
 */
export function loadEnv(files: string[] = envFileCandidates()): string[] {
  const loaded: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    loaded.push(file);
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      let line = rawLine.trim();
      if (line.startsWith("export ")) line = line.slice(7).trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line
        .slice(eq + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/s, "$2");
      if (!key) continue;
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
  return loaded;
}

export interface AppConfig {
  /** Bark 服务器地址，例如 https://api.day.app */
  server: string;
  /** 默认推送目标（BARK_KEY），同时作为 MCP HTTP 的 bearer token */
  deviceKey: string;
  /** crypto_keys.json 的绝对路径 */
  keysFile: string;
  keys: CryptoKeys;
  /** 是否允许调用方自带 device_key（BARK_ALLOW_CUSTOM_KEY=1） */
  allowCustomKey: boolean;
}

function resolvePath(value: string): string {
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function randomString(length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(Math.max(8, length)));
    for (const byte of bytes) {
      if (byte >= limit) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export const generateKey = randomString;

function readKeysFile(file: string): Partial<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function saveKeys(file: string, keys: CryptoKeys): void {
  writeFileSync(file, `${JSON.stringify(keys, null, 2)}\n`, "utf8");
}

/** 读取本地密钥：文件里的合法值优先，否则用写死的 DEFAULT_KEYS。 */
export function loadKeys(file: string): CryptoKeys {
  const saved = readKeysFile(file);
  const keys = {} as CryptoKeys;
  let fromFile = false;
  for (const algorithm of ALGORITHMS) {
    const candidate = saved[algorithm];
    if (typeof candidate === "string" && candidate.length === ALGOS[algorithm]) {
      keys[algorithm] = candidate;
      fromFile = true;
    } else {
      keys[algorithm] = DEFAULT_KEYS[algorithm];
    }
  }
  // 只在文件里确实有有效密钥时回写，避免默认值被无谓地固化成文件
  if (fromFile) saveKeys(file, keys);
  return keys;
}

export function loadConfig(): AppConfig {
  loadEnv();
  const server = (process.env.BARK_SERVER?.trim() || DEFAULT_SERVER).replace(/\/+$/, "");
  const deviceKey = (process.env.BARK_KEY ?? "").trim();
  const keysFile = resolvePath(process.env.BARK_KEYS_FILE?.trim() || KEYS_FILE_NAME);
  return {
    server,
    deviceKey,
    keysFile,
    keys: loadKeys(keysFile),
    allowCustomKey: process.env.BARK_ALLOW_CUSTOM_KEY !== "0",
  };
}
