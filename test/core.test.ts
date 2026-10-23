import { describe, expect, it } from "bun:test";

import { buildPayload, isSuccess, mask, pushNotification } from "../src/bark.ts";
import { ALGORITHMS, ALGOS, loadEnv, type AppConfig } from "../src/config.ts";
import { decryptBytes, encryptBytes, encryptJson, randomIv } from "../src/crypto.ts";

const key = "1234567890123456";

describe("加密", () => {
  it("命中 Bark 官方 AES-128-CBC 文档向量", () => {
    const { ciphertext } = encryptBytes(
      Buffer.from('{"body": "test", "sound": "birdsong"}', "utf8"),
      key,
      "aes-128",
      "cbc",
      "1234567890123456",
    );
    expect(ciphertext).toBe("+aPt5cwN9GbTLLSFri60l3h1X00u/9j1FENfWiTxhNHVLGU+XoJ15JJG5W/d/yf0");
  });

  for (const algorithm of ALGORITHMS) {
    const secret = "K".repeat(ALGOS[algorithm]);
    for (const mode of ["cbc", "ecb", "gcm"] as const) {
      it(`${algorithm}/${mode} 可往返`, () => {
        const payload = { title: "标题", body: "hello 世界", badge: 1 };
        const { ciphertext, iv } = encryptJson(payload, secret, algorithm, mode);
        expect(iv.length).toBe(mode === "gcm" ? 12 : mode === "cbc" ? 16 : 0);
        const raw = decryptBytes(ciphertext, secret, algorithm, mode, iv);
        expect(JSON.parse(raw.toString("utf8"))).toEqual(payload);
      });
    }
  }

  it("GCM 的认证标签拼在密文尾部（长度 = 明文 + 16 字节）", () => {
    const plain = Buffer.from("abc");
    const { ciphertext } = encryptBytes(plain, key, "aes-128", "gcm", "0123456789ab");
    expect(Buffer.from(ciphertext, "base64").length).toBe(plain.length + 16);
  });

  it("IV 长度不对时报错", () => {
    expect(() => encryptBytes(Buffer.from("a"), key, "aes-128", "cbc", "short")).toThrow();
    expect(() => encryptBytes(Buffer.from("a"), key, "aes-128", "gcm", "0123456789abcdef")).toThrow();
  });

  it("KEY 长度不对时报错", () => {
    expect(() => encryptBytes(Buffer.from("a"), "short", "aes-256", "cbc")).toThrow();
  });

  it("randomIv 只含 16 进制字符", () => {
    expect(randomIv(16)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("payload", () => {
  it("剔掉控制字段与空值", () => {
    expect(
      buildPayload({ title: "hi", body: "", subtitle: undefined, encrypt: true, device_key: "x" } as never),
    ).toEqual({ title: "hi" });
  });

  it("保留 badge=0", () => {
    expect(buildPayload({ badge: 0 })).toEqual({ badge: 0 });
  });
});

describe("Bark 响应判定", () => {
  it("单条 code=200", () => expect(isSuccess({ code: 200, message: "success" })).toBe(true));
  it("单条 code=400", () => expect(isSuccess({ code: 400, message: "failed" })).toBe(false));
  it("批量全部成功", () => expect(isSuccess({ data: [{ code: 200 }, { code: 200 }] })).toBe(true));
  it("批量部分失败", () => expect(isSuccess({ data: [{ code: 200 }, { code: 400 }] })).toBe(false));
  it("非对象", () => expect(isSuccess("oops")).toBe(false));
});

describe("脱敏", () => {
  it("长 key 只露头尾", () => expect(mask("abcdefghijklmn")).toBe("abcd…klmn"));
  it("短 key 完全隐藏", () => expect(mask("short")).toBe("已隐藏"));
});

describe("pushNotification", () => {
  const baseConfig = (): AppConfig => ({
    server: "https://api.day.app",
    deviceKey: "SERVERKEY1234567",
    keysFile: "/tmp/none/crypto_keys.json",
    keys: {
      "aes-128": "1234567890123456",
      "aes-192": "123456789012345678901234",
      "aes-256": "12345678901234567890123456789012",
    },
    allowCustomKey: true,
  });

  it("默认使用 BARK_KEY 并发送明文", async () => {
    let captured: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ code: 200, message: "success" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await pushNotification(
      { title: "hi", body: "hello" },
      {},
      { config: baseConfig(), fetchImpl },
    );

    expect(result.ok).toBe(true);
    expect(captured).toEqual({ device_key: "SERVERKEY1234567", title: "hi", body: "hello" });
    expect(result.request.device_key).toBe("SERV…4567");
  });

  it("加密时只发 ciphertext/iv，并透传 id 与 delete", async () => {
    let captured: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ code: 200 }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await pushNotification(
      { title: "secret", id: "job-1", delete: "1" },
      { encrypt: true, algorithm: "aes-128", mode: "cbc" },
      { config: baseConfig(), fetchImpl },
    );

    expect(result.ok).toBe(true);
    expect(result.ciphertext).toBeString();
    expect(captured.ciphertext).toBeString();
    expect(String(captured.iv)).toMatch(/^[0-9a-f]{16}$/);
    expect(captured.title).toBeUndefined();
    expect(captured.id).toBe("job-1");
    expect(captured.delete).toBe("1");
  });

  it("批量推送使用 device_keys", async () => {
    let captured: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: [{ code: 200 }, { code: 200 }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await pushNotification(
      { title: "batch", device_keys: ["key-aaaaaa1111", "key-bbbbbb2222"] },
      {},
      { config: baseConfig(), fetchImpl },
    );
    expect(result.ok).toBe(true);
    expect(captured.device_keys).toEqual(["key-aaaaaa1111", "key-bbbbbb2222"]);
  });

  it("没有可用 key 时报错", async () => {
    const config = { ...baseConfig(), deviceKey: "" };
    await expect(pushNotification({ title: "x" }, {}, { config })).rejects.toThrow(/device_key/);
  });

  it("网络异常时返回 ok=false 而不是抛错", async () => {
    const fetchImpl = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const result = await pushNotification({ title: "x" }, {}, { config: baseConfig(), fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("连接 Bark 服务器失败");
  });

  it("禁止自定义 key 时拦截", async () => {
    const config = { ...baseConfig(), allowCustomKey: false };
    await expect(
      pushNotification({ title: "x", device_key: "other-key-1234" }, {}, { config }),
    ).rejects.toThrow(/禁止自定义/);
  });
});

describe("配置", () => {
  it("loadEnv 不覆盖已有变量", async () => {
    const file = `/tmp/bark-env-${crypto.randomUUID()}.env`;
    await Bun.write(file, 'export BARK_TEST_KEY="from-file"\n# comment\nBARK_OTHER=1\n');
    process.env.BARK_TEST_KEY = "from-env";
    loadEnv([file]);
    expect(process.env.BARK_TEST_KEY).toBe("from-env");
    expect(process.env.BARK_OTHER).toBe("1");
    delete process.env.BARK_TEST_KEY;
    delete process.env.BARK_OTHER;
  });
});
