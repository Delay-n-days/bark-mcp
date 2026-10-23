# python-legacy

这是最初用来做实验的 Python（FastAPI）实现，只作为「加密行为参考」保留，不再维护。

功能已被仓库根目录的 TypeScript / Bun 版本完整覆盖（含 Web 游乐场与 MCP 服务），
日常使用请用根目录的 `bun run dev` 或 `bun dist/bark-mcp.js`。

注意：这里的 `main.py` 需要同名目录下的 `static/index.html` 才能渲染页面，
该文件已随新版迁移到 `../src/web/index.html`。若确实要运行旧版，请自行复制一份。
