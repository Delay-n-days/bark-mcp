/**
 * 构建 Node 可执行产物：dist/bark-mcp.js
 *
 * 用 esbuild（不依赖 Bun）：
 * - `--platform=node --format=esm` 产出纯 Node 代码，Node 20+ 直接运行；
 * - 页面由 `scripts/gen-web.ts` 生成为 TS 常量（见 src/web/index-html.generated.ts）；
 * - `@modelcontextprotocol/sdk` 一起打包，用户 `npx -y <tgz>` 不需要额外装依赖。
 */
import { build } from "esbuild";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, "dist");
const outfile = join(outdir, "bark-mcp.js");
const minify = process.argv.includes("--minify");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const result = await build({
  entryPoints: [join(root, "src/main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify,
  sourcemap: process.argv.includes("--sourcemap") ? "linked" : false,
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
});

const info = await stat(outfile);
console.log(`✔ ${outfile} — ${(info.size / 1024).toFixed(1)} KB`);

// 加 node shebang，chmod +x，使 `npx`/直接执行都能跑
const code = await readFile(outfile, "utf8");
if (!code.startsWith("#!")) {
  await writeFile(outfile, `#!/usr/bin/env node\n${code}`, "utf8");
}
if (process.platform !== "win32") await chmod(outfile, 0o755);

/** 冒烟：产物必须能在 Node 下自报版本（GUI 无关、不连网）。 */
const { spawnSync } = await import("node:child_process");
const smoke = spawnSync(process.execPath, [outfile, "--version"], {
  encoding: "utf8",
  env: { ...process.env, BARK_KEY: "" },
});
if (smoke.status !== 0 || !smoke.stdout.includes("bark-mcp v")) {
  console.error("冒烟测试失败:", smoke.status, smoke.stdout, smoke.stderr);
  process.exit(1);
}
console.log(`✔ 冒烟测试通过（--version，Node ${process.versions.node}）`);

const inputs = Object.keys(result.metafile?.inputs ?? {});
console.log(`✔ 打包 ${inputs.length} 个模块（含 MCP SDK 与内联页面）`);
