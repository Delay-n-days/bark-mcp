/**
 * 打包成单文件 JS：dist/bark-mcp.js
 *
 * Bun 支持把 .html 以 text 导入，所以游乐场页面直接内联进产物，
 * 发布时只需要这一个文件。
 */
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const outdir = join(root, "dist");
const entry = join(root, "src/main.ts");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [entry],
  outdir,
  target: "bun",
  format: "esm",
  naming: "bark-mcp.js",
  minify: process.argv.includes("--minify"),
  sourcemap: process.argv.includes("--sourcemap") ? "linked" : "none",
  define: {
    "process.env.BARK_BUILD": JSON.stringify("1"),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

/**
 * Bun 会保留源码里的 shebang，但不会自动补；产物没 shebang 时手动加一行，
 * 这样 `bun dist/bark-mcp.js` 和 `chmod +x` 后直接执行都能用。
 */
const entryOutput = result.outputs.find((output) => output.path.endsWith("bark-mcp.js"));
if (entryOutput) {
  const text = await Bun.file(entryOutput.path).text();
  if (!text.startsWith("#!")) {
    await Bun.write(entryOutput.path, `#!/usr/bin/env bun
${text}`);
  }
}

for (const output of result.outputs) {
  const info = await stat(output.path);
  console.log(`✔ ${output.path.replace(root, "")} — ${(info.size / 1024).toFixed(1)} KB`);
}

/**
 * 冒烟测试：单文件必须能自报版本，且不依赖源码目录。
 */
const smoke = Bun.spawnSync({
  cmd: [process.execPath, join(outdir, "bark-mcp.js"), "--version"],
  cwd: outdir,
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, BARK_KEY: "" },
});
const stdout = smoke.stdout.toString();
if (smoke.exitCode !== 0 || !stdout.includes("bark-mcp v")) {
  console.error("冒烟测试失败：", smoke.exitCode, stdout, smoke.stderr.toString());
  process.exit(1);
}
console.log("✔ 冒烟测试通过（--version）");

const files = await readdir(outdir);
console.log(`\ndist/ 内容: ${files.join(", ")}`);
