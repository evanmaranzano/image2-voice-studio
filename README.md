# Image2 Voice Studio

基于 `evanmaranzano/image2-generator` 的本地可运行版本，加入简化 UI、语音转文字、拼音虚拟键盘和安全代理。

## 功能

- 文生图：`POST /v1/images/generations`
- 免费语音转文字：优先使用 Chrome/Edge 的 Web Speech API；浏览器不支持时可走 MiMo-V2-Omni 备选
- 真实模式：API key 只放在本地环境变量或 Netlify Functions 环境变量中

## 本地运行

先设置 key：

```powershell
$env:OPENAI_API_KEY = "sk-..."
$env:OPENAI_BASE_URL = "https://api.change2pro.com"
python serve.py
```

打开：

```text
http://127.0.0.1:8765/
```

`API Base` 留空即可走同源本地代理。

也可以写入本地 `.env` 文件，项目会自动读取；`.env` 已被 `.gitignore` 忽略。

MiMo 语音转文字备选需要额外配置：

```powershell
$env:MIMO_API_KEY = "tp-..."
$env:MIMO_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1"
$env:MIMO_MODEL = "MiMo-V2-Omni"
```

页面里的“MiMo 录音转写”按钮会把录音发到本地 `/stt/transcribe`，再由本地代理转发到 MiMo。

## Netlify 部署

静态页已在 Netlify，线上要直接可用，必须配置环境变量让 Netlify Functions 代发请求：

```powershell
npx netlify env:set OPENAI_API_KEY "sk-..."
npx netlify env:set OPENAI_BASE_URL "https://api.change2pro.com"
npx netlify env:set OPENAI_MODEL "gpt-image-2"
npx netlify env:set MIMO_API_KEY "tp-..."
npx netlify env:set MIMO_BASE_URL "https://token-plan-cn.xiaomimimo.com/v1"
npx netlify env:set MIMO_MODEL "MiMo-V2-Omni"
npx netlify env:set ALLOWED_ORIGINS "https://your-site.netlify.app"
```

设置后重新部署：

```powershell
npx netlify deploy --prod
```

默认同源调用 `/config`、`/v1/images/generations`、`/stt/transcribe`，前端不用再填外部 API 地址。

## 验证

```powershell
python -m unittest discover -s tests -p "test_*.py"
```

如果本机存在第三方包也叫 `tests`，不要用 `python -m unittest tests/test_contract.py`，用上面的 `discover -s tests`。

## 安全边界

- 不在前端、Worker 或 Python 文件中写入任何 API key
- 不在前端或仓库文件中写入任何 API key
- 仅开放 `/v1/images/generations` 与 `/stt/transcribe`
- 语音转文字只开放 `/stt/transcribe`，并限制为 base64 音频数据
- 本地代理和 Netlify Functions 都限制请求体为 10MB
- 公网部署时应配置 `ALLOWED_ORIGINS`
- 没有 API key 时真实接口返回明确错误

无法承诺“绝对无漏洞”；当前实现只按本项目范围做了必要的密钥隔离、路径白名单、大小限制和 SSRF 防护。
