# Image2 Voice Studio

文生图 + 语音转文字 Web 应用，Python 本地开发 + Netlify Functions 部署。

## 本地运行

项目路径：`F:\image2`（不在 home 目录）
`python serve.py` → http://127.0.0.1:8765（需 cd 到 F:\image2 再启动）
打开浏览器：`cmd.exe /c start http://127.0.0.1:8765`
一键启动：双击 `start.bat`（自动打开浏览器 + 启动 serve.py）

## Netlify 部署

```bash
npx netlify deploy --prod --no-build --dir=. --functions=netlify/functions
```

必须用 `--no-build`，CLI v26 的 build 步骤有 "Failed retrieving extensions: fetch failed" bug。
环境变量通过 Netlify Dashboard 或 REST API 设置，不要部署 .env。

## 项目结构

- `serve.py` — 本地 Python HTTP 代理（生产环境不用）
- `index.html` — 前端单页
- `netlify/functions/proxy.mjs` — Netlify Function，处理 /config、/healthz、/v1/images/generations
- `worker.js` — Cloudflare Worker 版本（备用）
- `tests/test_contract.py` — 契约测试

## 测试

`python -m unittest discover -s tests -p "test_*.py"`

## 已知坑

- Netlify CLI `npx netlify deploy --prod` 不加 `--no-build` 会失败
- Netlify 免费版 CDN 30s 超时，生图 API 需 30-120s，公网部署会 502（lambda crash status code 0）；展厅用 `python serve.py` 本地跑
- Netlify Function 的 `req.arrayBuffer()` 不能直接作为 `fetch` body，用 `req.json()` + `JSON.stringify()` 更稳
- `codegraph sync` 在批量改动后需手动执行
- `.codegraph/` 和 `.cursor/` 已在 .gitignore
- `feature/chatgpt-style` 分支：白色 ChatGPT 对话式 UI + 虚拟键盘 + 语音转录
- JS 块内 `function fn()` 不在全局作用域，`onclick="fn()"` 需改为 `window.fn`
- `pkill -f` 在 MINGW64 下不可靠，重启 serve.py 必须用 `taskkill //F //IM python.exe` 全杀再启动，否则旧进程占端口新代码不生效
- 重启后用 `curl -s http://127.0.0.1:8765/.netlify/functions/conversations` 验证数据是否从 `conversations.json` 正确加载
- `_sanitizeForStorage` 会清空 base64 图片 URL；localStorage 受限于 ~5MB 只能存 sanitized 版本，远端（serve.py / Netlify Blobs）必须存完整数据，否则历史图片丢失
- `conversations.json` 已在 .gitignore，本地持久化用，勿入库
- conversations.json 根是数组，每项：`{id, title, createdAt, updatedAt, settings, messages[], lastUserText}`
- messages 中 `type: "image"` 的项是独立对象，`url` 字段存 data:image base64；不是存在 user message 里
- 查所有已生成图片：遍历 `conversations[].messages[]` 筛选 `type === "image"`

## gh CLI 代理

`GH_HTTP_PROXY=http://127.0.0.1:7897 gh repo create ...` 才能走代理，`https_proxy` / `HTTP_PROXY` 无效。
