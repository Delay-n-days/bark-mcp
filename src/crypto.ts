/**
 * Bark 官方加密方案的实现（AES-128/192/256 + CBC/ECB/GCM）。
 *
 * 约定：密文与 IV 都是 base64/字符串，GCM 的认证标签按 Bark App 的约定
 * 拼在密文尾部（Node/Bun 的 createCipheriv 先 update 再 final + getAuthTag）。
 */
import { createCipheriv, createDecipheriv } from "node:crypto";

import { ALGOS, type Algorithm, type Mode } from "./config.ts";

const HEX = "0123456789abcdef";

/** Bark App 生成 IV 的方式：n 位 16 进制字符串。 */
export function randomIv(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const byte of bytes) out += HEX[byte & 0x0f];
  return out;
}

function nodeAlgorithm(algorithm: Algorithm, mode: Mode): string {
  return `${algorithm}-${mode}`;
}

function checkIvLength(iv: string, mode: Mode): void {
  if (mode === "cbc" && iv.length !== 16) {
    throw new Error(`CBC 的 IV 必须是 16 个字符，收到 ${iv.length} 个`);
  }
  if (mode === "gcm" && iv.length !== 12) {
    throw new Error(`GCM 的 IV 必须是 12 个字符，收到 ${iv.length} 个`);
  }
}

export interface EncryptedPayload {
  ciphertext: string;
  /** ECB 没有 IV，返回空字符串 */
  iv: string;
}

/**
 * 加密任意字节。返回以 base64 表示的密文和实际使用的 IV。
 */
export function encryptBytes(
  data: Buffer | Uint8Array,
  key: string,
  algorithm: Algorithm,
  mode: Mode,
  iv?: string,
): EncryptedPayload {
  const keyBytes = Buffer.from(key, "utf8");
  const expected = ALGOS[algorithm];
  if (keyBytes.length !== expected) {
    throw new Error(`${algorithm} 的 KEY 必须是 ${expected} 个字符，当前 ${keyBytes.length} 个`);
  }

  if (mode === "ecb") {
    const cipher = createCipheriv(nodeAlgorithm(algorithm, "ecb"), keyBytes, null);
    const out = Buffer.concat([cipher.update(data), cipher.final()]);
    return { ciphertext: out.toString("base64"), iv: "" };
  }

  const actualIv = iv && iv.length > 0 ? iv : randomIv(mode === "gcm" ? 12 : 16);
  checkIvLength(actualIv, mode);
  const ivBuffer = Buffer.from(actualIv, "utf8");

  if (mode === "gcm") {
    const cipher = createCipheriv(`${algorithm}-gcm`, keyBytes, ivBuffer, { authTagLength: 16 });
    const body = Buffer.concat([cipher.update(data), cipher.final()]);
    // Bark App 约定：认证标签拼在密文尾部
    return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString("base64"), iv: actualIv };
  }

  const cipher = createCipheriv(`${algorithm}-cbc`, keyBytes, ivBuffer);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return { ciphertext: body.toString("base64"), iv: actualIv };
}

/** 解密（主要给测试与自检用）。GCM 的标签从密文尾部切出。 */
export function decryptBytes(
  ciphertext: string,
  key: string,
  algorithm: Algorithm,
  mode: Mode,
  iv = "",
): Buffer {
  const keyBytes = Buffer.from(key, "utf8");
  const raw = Buffer.from(ciphertext, "base64");

  if (mode === "ecb") {
    const decipher = createDecipheriv(nodeAlgorithm(algorithm, "ecb"), keyBytes, null);
    return Buffer.concat([decipher.update(raw), decipher.final()]);
  }

  checkIvLength(iv, mode);
  if (mode === "gcm") {
    if (raw.length <= 16) throw new Error("GCM 密文长度不足，缺少认证标签");
    const body = raw.subarray(0, raw.length - 16);
    const tag = raw.subarray(raw.length - 16);
    const decipher = createDecipheriv(`${algorithm}-gcm`, keyBytes, Buffer.from(iv, "utf8"), {
      authTagLength: 16,
    });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  }

  const decipher = createDecipheriv(nodeAlgorithm(algorithm, "cbc"), keyBytes, Buffer.from(iv, "utf8"));
  return Buffer.concat([decipher.update(raw), decipher.final()]);
}

/** 与 Bark 服务端/App 一致的紧凑 JSON（无空格，保留中文）。 */
export function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

export function encryptJson(
  payload: Record<string, unknown>,
  key: string,
  algorithm: Algorithm,
  mode: Mode,
): EncryptedPayload {
  return encryptBytes(Buffer.from(compactJson(payload), "utf8"), key, algorithm, mode);
}
