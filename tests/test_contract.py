import importlib.util
import os
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ProjectContractTests(unittest.TestCase):
    def test_required_files_exist(self):
        for name in [".gitignore", "README.md", "index.html", "serve.py", "worker.js"]:
            self.assertTrue((ROOT / name).is_file(), f"missing {name}")

    def test_frontend_contains_core_flow_without_secrets(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        required = [
            "Image2 Voice Studio",
            "SpeechRecognition",
            "webkitSpeechRecognition",
            "MediaRecorder",
            "/stt/transcribe",
            "id=\"mimoButton\"",
            "id=\"candidateList\"",
            "id=\"pinyinReadout\"",
            "中文拼音虚拟键盘",
            "/v1/images/generations",
            "/config",
            "id=\"generateBtn\"",
            "placeholder=\"留空表示走当前站点代理\"",
            "默认走当前站点代理 /v1/images/generations",
            "resolveEndpoint(\"/v1/images/generations\")",
        ]
        for text in required:
            self.assertIn(text, html)
        forbidden = [
            "type=\"file\"",
            "id=\"fileInput\"",
            "id=\"refPreview\"",
            "添加 1 张参考图",
            "/v1/images/edits",
            "苹果风简洁工作台，保留语音、拼音键盘和 MiMo 备选转写。",
            "data-mode=\"demo\"",
            "data-mode=\"live\"",
            "Demo Mode",
            "演示模式",
            "本地模拟预览",
        ]
        for text in forbidden:
            self.assertNotIn(text, html)
        self.assertNotRegex(html, re.compile(r"sk-[A-Za-z0-9_-]{12,}"))

    def test_server_proxy_is_locked_down(self):
        spec = importlib.util.spec_from_file_location("serve", ROOT / "serve.py")
        serve = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(serve)

        self.assertEqual(
            serve.ALLOWED_API_PATHS,
            {"/v1/images/generations"},
        )
        self.assertEqual(serve.STT_PATH, "/stt/transcribe")
        self.assertEqual(serve.MIMO_BASE_URL, "https://token-plan-cn.xiaomimimo.com/v1")
        self.assertEqual(serve.MIMO_MODEL, "MiMo-V2-Omni")
        self.assertEqual(serve.MAX_UPLOAD_BYTES, 10 * 1024 * 1024)
        self.assertEqual(
            serve.build_upstream_url("https://www.packyapi.com/v1", "/v1/images/generations"),
            "https://www.packyapi.com/v1/images/generations",
        )
        self.assertEqual(
            serve.build_upstream_url("https://www.packyapi.com", "/v1/images/generations"),
            "https://www.packyapi.com/v1/images/generations",
        )
        self.assertEqual(serve.MODEL, "gpt-image-2")
        allowed = serve.parse_allowed_origins("http://127.0.0.1:8765,https://app.example.com")
        self.assertTrue(serve.is_origin_allowed("https://app.example.com", allowed))
        self.assertFalse(serve.is_origin_allowed("https://evil.example.com", allowed))
        self.assertEqual(serve.ORIGIN_REJECT_STATUS, 403)
        mime_type, audio_format, audio_bytes = serve.parse_audio_data_url(
            "data:audio/webm;base64,UklGRg=="
        )
        self.assertEqual(mime_type, "audio/webm")
        self.assertEqual(audio_format, "webm")
        self.assertGreater(len(audio_bytes), 0)
        self.assertEqual(
            serve.extract_transcript({"choices": [{"message": {"content": "  你好世界  "}}]}),
            "你好世界",
        )
        self.assertEqual(
            serve.extract_transcript({"choices": [{"message": {"reasoning_content": "  语音内容  "}}]}),
            "语音内容",
        )
        self.assertEqual(serve.extract_transcript({"text": "转写文本"}), "转写文本")

    def test_worker_has_allowlist_and_no_embedded_secret(self):
        worker = (ROOT / "worker.js").read_text(encoding="utf-8")
        self.assertIn("/v1/images/generations", worker)
        self.assertNotIn("/v1/images/edits", worker)
        self.assertIn("OPENAI_API_KEY", worker)
        self.assertNotRegex(worker, re.compile(r"sk-[A-Za-z0-9_-]{12,}"))
        self.assertIn("ALLOWED_ORIGINS", worker)
        self.assertIn("isOriginAllowed", worker)
        self.assertNotIn('"Access-Control-Allow-Origin": origin', worker)
        self.assertIn("buildUpstreamUrl", worker)
        self.assertIn("rejectDisallowedOrigin", worker)
        self.assertIn("return rejectDisallowedOrigin(request, env)", worker)
        self.assertIn("/stt/transcribe", worker)
        self.assertIn("MIMO_API_KEY", worker)
        self.assertIn("MiMo-V2-Omni", worker)
        self.assertNotRegex(worker, re.compile(r"tp-[A-Za-z0-9_-]{12,}"))

    def test_netlify_function_proxy_exists_and_has_no_embedded_secret(self):
        fn = (ROOT / "netlify/functions/proxy.mjs").read_text(encoding="utf-8")
        self.assertIn("/v1/images/generations", fn)
        self.assertIn("/stt/transcribe", fn)
        self.assertIn("/config", fn)
        self.assertIn("?route=generate", (ROOT / "index.html").read_text(encoding="utf-8"))
        self.assertIn("getFallbackRoute", fn)
        self.assertIn("OPENAI_API_KEY", fn)
        self.assertIn("MIMO_API_KEY", fn)
        self.assertIn("https://api.change2pro.com", fn)
        self.assertNotIn("/v1/images/edits", fn)
        self.assertNotRegex(fn, re.compile(r"sk-[A-Za-z0-9_-]{12,}"))


if __name__ == "__main__":
    unittest.main()
