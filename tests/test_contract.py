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
            "AI 画图工坊",
            "SpeechRecognition",
            "webkitSpeechRecognition",
            "id=\"candList\"",
            "id=\"pyReadout\"",
            "/v1/images/generations",
            "/config",
            "id=\"sendBtn\"",
            "id=\"clearBtn\"",
            "isExhibit",
            "isValidUrl",
            "LOADING_MSGS",
            "scheduleReset",
            "preset",
            "presetTexts",
        ]
        for text in required:
            self.assertIn(text, html)
        forbidden = [
            "type=\"file\"",
            "id=\"fileInput\"",
            "id=\"refPreview\"",
            "添加 1 张参考图",
            "/v1/images/edits",
            "data-mode=\"demo\"",
            "data-mode=\"live\"",
            "Demo Mode",
            "演示模式",
            "本地模拟预览",
            "mimoBtn",
            "MiMo",
            "/stt/transcribe",
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
        self.assertEqual(serve.sanitize_content_type("application/json; charset=utf-8"), "application/json")
        self.assertEqual(serve.sanitize_content_type("text/html"), "application/json")
        self.assertEqual(serve.sanitize_content_type("image/png"), "image/png")

    def test_worker_has_allowlist_and_no_embedded_secret(self):
        worker = (ROOT / "worker.js").read_text(encoding="utf-8")
        self.assertIn("/v1/images/generations", worker)
        self.assertNotIn("/v1/images/edits", worker)
        self.assertIn("OPENAI_API_KEY", worker)
        self.assertNotRegex(worker, re.compile(r"sk-[A-Za-z0-9_-]{12,}"))
        self.assertIn("ALLOWED_ORIGINS", worker)
        self.assertIn("isOriginAllowed", worker)
        self.assertNotRegex(worker, re.compile(r"Access-Control-Allow-Origin.*null"))
        self.assertIn("buildUpstreamUrl", worker)
        self.assertIn("rejectDisallowedOrigin", worker)
        self.assertIn("return rejectDisallowedOrigin(request, env)", worker)
        # MiMo / STT must be removed
        self.assertNotIn("/stt/transcribe", worker)
        self.assertNotIn("MIMO_API_KEY", worker)
        self.assertNotIn("MiMo", worker)
        self.assertIn('url.pathname === "/config"', worker)

    def test_netlify_function_proxy_exists_and_has_no_embedded_secret(self):
        fn = (ROOT / "netlify/functions/proxy.mjs").read_text(encoding="utf-8")
        self.assertIn("/v1/images/generations", fn)
        self.assertIn("/config", fn)
        self.assertIn("getFallbackRoute", fn)
        self.assertIn("OPENAI_API_KEY", fn)
        self.assertNotIn("/v1/images/edits", fn)
        self.assertNotRegex(fn, re.compile(r"sk-[A-Za-z0-9_-]{12,}"))
        # MiMo / STT must be removed
        self.assertNotIn("/stt/transcribe", fn)
        self.assertNotIn("MIMO_API_KEY", fn)
        self.assertNotIn("MiMo", fn)
        # Netlify function must NOT allow arbitrary origins when ALLOWED_ORIGINS empty
        self.assertNotIn("if (!allowed.length) return true;", fn)
        # Must not return "null" as ACAO
        self.assertNotRegex(fn, re.compile(r"origin \|\| [\"']null[\"']"))


if __name__ == "__main__":
    unittest.main()
