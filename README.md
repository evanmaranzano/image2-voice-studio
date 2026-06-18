# AI 画图工坊 (Image2 Voice Studio)

文生图 + 语音转文字 Web 应用，Apple 风格 UI，支持展厅模式。

## 功能

- **文生图**：输入文字描述，AI 生成图片（支持 3:2 / 1:1 / 2:3 / 16:9 四种比例）
- **语音输入**：Chrome/Edge Web Speech API 实时语音识别
- **拼音虚拟键盘**：内置中文拼音输入法（开发/调试用）
- **预设示例**：一键填入预设提示词，快速体验
- **展厅模式**：URL 加 `?exhibit` 启用，自动隐藏高级选项、锁定配置、60 秒自动重置
- **多后端代理**：Python 本地 / Netlify Functions / Cloudflare Worker 三种部署方式

## 快速开始

### 本地运行（推荐展厅场景）

```powershell
# 方式 1：环境变量
$env:OPENAI_API_KEY = "sk-..."
$env:OPENAI_BASE_URL = "https://api.change2pro.com"
python serve.py

# 方式 2：写入 .env 文件（自动读取，已 gitignore）
```

打开 `http://127.0.0.1:8765/?exhibit` 即可使用。

### Netlify 部署

```powershell
# 配置环境变量
npx netlify env:set OPENAI_API_KEY "sk-..."
npx netlify env:set OPENAI_BASE_URL "https://api.change2pro.com"
npx netlify env:set OPENAI_MODEL "gpt-image-2"
npx netlify env:set ALLOWED_ORIGINS "https://your-site.netlify.app"

# 部署（必须 --no-build）
npx netlify deploy --prod --no-build --dir=. --functions=netlify/functions
```

> **注意**：Netlify 免费版函数超时 10 秒、CDN 超时 30 秒。生图 API 通常需要 30-120 秒，**展厅场景建议用本地 `python serve.py`**，无超时限制。

### Cloudflare Worker

将 `worker.js` 部署为 Cloudflare Worker，配置环境变量 `OPENAI_API_KEY` / `ALLOWED_ORIGINS` 等。

## 展厅模式

在 URL 后加 `?exhibit`：

- 隐藏高级选项（API Base、模型、输出格式）
- 隐藏虚拟键盘切换和下载按钮
- 锁定语音为中文追加模式
- 60 秒无操作自动清空所有内容
- 触摸设备自动隐藏快捷键提示

## 项目结构

```
index.html                    # 前端单页（CSS + JS 内联）
serve.py                      # Python 本地 HTTP 代理
worker.js                     # Cloudflare Worker 版本
netlify/functions/proxy.mjs   # Netlify Function
tests/test_contract.py        # 契约测试
netlify.toml                  # Netlify 部署配置
```

## 测试

```powershell
python -m unittest discover -s tests -p "test_*.py"
```

## 安全

- API Key 仅存储在环境变量中，不落地到前端或仓库
- 路径白名单：仅开放 `/v1/images/generations`
- 请求体大小限制 10MB
- 返回的图片 URL 校验 scheme（仅允许 https/http/data:image）
- 上游错误信息脱敏，不泄露内部细节
- CORS 空配置时回退为只允许请求自身 origin
- 公网部署时应配置 `ALLOWED_ORIGINS` 环境变量

## 技术栈

- **前端**：原生 HTML/CSS/JS，Apple 风格 UI，零依赖
- **本地代理**：Python 标准库 `http.server` + `urllib`
- **Netlify**：Netlify Functions (ES Module)
- **Worker**：Cloudflare Workers
- **AI 服务**：OpenAI Images API（兼容中转站）

## License

MIT
