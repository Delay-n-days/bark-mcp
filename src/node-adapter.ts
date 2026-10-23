/**
 * 最小的 node:http ↔ Web Request/Response 适配层。
 *
 * 这样同一份逻辑在 Bun 和 Node 上都能跑：内部一律用标准 Web API
 * （`Request` / `Response` / `ReadableStream`），MCP SDK 的
 * WebStandardStreamableHTTPServerTransport 也正好要求这些类型。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export type WebHandler = (req: Request) => Promise<Response> | Response;

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") return undefined;

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("请求体过大");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function toWebRequest(req: IncomingMessage, boundHost: string): Promise<Request> {
  const host = req.headers.host ?? boundHost;
  const url = `http://${host}${req.url ?? "/"}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, value);
  }

  const body = await readBody(req);
  return new Request(url, {
    method: req.method ?? "GET",
    headers,
    // Buffer 的 .buffer 是 ArrayBuffer，直接塞给 fetch 的 BodyInit
    ...(body && body.length > 0
      ? { body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer }
      : {}),
  });
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;

  const cookies = response.headers.getSetCookie?.() ?? [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    res.setHeader(key, value);
  });
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);

  // 不设 Content-Length，交给 Node 用 chunked，SSE 才能持续推
  res.flushHeaders();

  if (!response.body || response.status === 204 || response.status === 304) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed || res.writableEnded) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      res.write(Buffer.from(value));
    }
    if (!res.writableEnded) res.end();
  } catch {
    await reader.cancel().catch(() => undefined);
    res.destroy();
  }
}

export interface NodeServerHandle {
  port: number;
  stop: (force?: boolean) => Promise<void>;
}

export function serveNode(
  handler: WebHandler,
  host: string,
  port: number,
): Promise<NodeServerHandle> {
  const server = createServer((req, res) => {
    void (async () => {
      let request: Request;
      try {
        request = await toWebRequest(req, host);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: message }));
        return;
      }

      try {
        const response = await handler(request);
        await writeWebResponse(res, response);
      } catch (error) {
        console.error("[bark-mcp] 请求处理失败:", error);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Internal error" }));
        } else {
          res.destroy();
        }
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      const actualPort =
        address && typeof address === "object" ? address.port : port;
      resolve({
        port: actualPort,
        stop: async (force = false) => {
          await new Promise<void>((done) => {
            if (force) {
              server.closeAllConnections?.();
            }
            server.close(() => done());
          });
        },
      });
    });
  });
}
