/**
 * 把 src/web/index.html 生成为可直接 import 的 TS 模块。
 *
 * 为什么要生成：Node 无法 `import "./x.html"`，而 esbuild 的 text loader
 * 只在打包时生效，测试（node --test 直接跑源码）会失败。
 * 生成出来的文件是唯一产物，`src/web/index.html` 仍是唯一真相源。
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "src", "web", "index.html");
const target = join(root, "src", "web", "index-html.generated.ts");

const html = await readFile(source, "utf8");
const banner = "// 本文件由 scripts/gen-web.ts 自动生成，请勿手改（真相源：src/web/index.html）\n";
await writeFile(target, `${banner}export default ${JSON.stringify(html)};\n`, "utf8");
console.log(`✔ 已生成 ${target.replace(root + "\\", "")} (${html.length} 字符)`);
