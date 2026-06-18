"""
Local runner for Image2 Voice Studio.

It serves index.html and proxies only the image endpoints needed by the UI.
Set OPENAI_API_KEY for live generation. Without a key, the UI still runs in
demo mode and live calls return a clear JSON error.
"""

from __future__ import annotations

import json
import os
import random
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingMixIn
from http.server import HTTPServer


ROOT = Path(__file__).resolve().parent


def load_dotenv(path: Path) -> None:
    if not path.is_file():
        sys.stderr.write(f"[serve] .env not found at {path}\n")
        return
    sys.stderr.write(f"[serve] loading {path}\n")
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_dotenv(ROOT / ".env")

PORT = int(os.environ.get("PORT", "8765"))
API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
BASE_URL = os.environ.get("OPENAI_BASE_URL", "").rstrip("/")
MODEL = os.environ.get("OPENAI_MODEL", "gpt-image-2").strip() or "gpt-image-2"
ALLOWED_API_PATHS = {"/v1/images/generations"}
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_PROMPT_CHARS = 4000
UPSTREAM_TIMEOUT_SECONDS = 300
UPSTREAM_RETRY_COUNT = 3
DEFAULT_ALLOWED_ORIGINS = {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}
ALLOWED_ORIGINS = DEFAULT_ALLOWED_ORIGINS | set()
ORIGIN_REJECT_STATUS = 403


def json_bytes(payload: dict) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def parse_allowed_origins(raw: str) -> set[str]:
    return {item.strip().rstrip("/") for item in raw.split(",") if item.strip()}


ALLOWED_ORIGINS |= parse_allowed_origins(os.environ.get("ALLOWED_ORIGINS", ""))


def is_origin_allowed(origin: str | None, allowed: set[str] | None = None) -> bool:
    if not origin:
        return True
    return origin.rstrip("/") in (allowed or ALLOWED_ORIGINS)


def build_upstream_url(base_url: str, path: str) -> str:  # CQ-09 sync: shared/utils.js#buildUpstreamUrl
    base = base_url.rstrip("/")
    if base.endswith("/v1") and path.startswith("/v1/"):
        return base + path[3:]
    return base + path


def sanitize_content_type(content_type: str | None) -> str:
    if content_type and content_type.startswith("application/json"):
        return "application/json"
    if content_type and content_type.startswith("image/"):
        return content_type.split(";", 1)[0].strip()
    return "application/json"


def request_with_retry(request: urllib.request.Request, timeout: int) -> urllib.response.addinfourl:
    last_error: Exception | None = None
    for attempt in range(UPSTREAM_RETRY_COUNT):
        try:
            return urllib.request.urlopen(request, timeout=timeout)
        except urllib.error.URLError as err:
            last_error = err
            if attempt == UPSTREAM_RETRY_COUNT - 1:
                break
            reason = str(getattr(err, "reason", err))
            if "Connection reset" not in reason and "10054" not in reason:
                break
            delay = min(8.0, (2**attempt) + random.uniform(0.0, 0.5))
            sys.stderr.write(f"[serve] upstream retry {attempt + 1}/{UPSTREAM_RETRY_COUNT} after {delay:.2f}s\n")
            time.sleep(delay)
    raise last_error or RuntimeError("upstream request failed")


class Handler(SimpleHTTPRequestHandler):
    server_version = "Image2VoiceStudio/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[%s] %s\n" % (self.address_string(), fmt % args))

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def _cors(self) -> None:
        origin = self.headers.get("Origin")
        if is_origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin or f"http://127.0.0.1:{PORT}")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Vary", "Origin")

    def _write(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _write_json(self, status: int, payload: dict) -> None:
        self._write(status, json_bytes(payload), "application/json; charset=utf-8")

    def do_OPTIONS(self) -> None:
        if not is_origin_allowed(self.headers.get("Origin")):
            self._write_json(ORIGIN_REJECT_STATUS, {"error": "origin is not allowed"})
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.end_headers()

    CONVERSATIONS_PATH = "/.netlify/functions/conversations"
    CONV_FILE = ROOT / "conversations.json"
    _conv_store: list = []

    @classmethod
    def _load_conv_store(cls) -> None:
        try:
            if cls.CONV_FILE.is_file():
                cls._conv_store = json.loads(cls.CONV_FILE.read_text(encoding="utf-8"))
                sys.stderr.write(f"[serve] loaded {len(cls._conv_store)} conversations from {cls.CONV_FILE}\n")
        except Exception as err:
            sys.stderr.write(f"[serve] failed to load conversations: {err}\n")

    @classmethod
    def _save_conv_store(cls) -> None:
        try:
            cls.CONV_FILE.write_text(json.dumps(cls._conv_store, ensure_ascii=False), encoding="utf-8")
        except Exception as err:
            sys.stderr.write(f"[serve] failed to save conversations: {err}\n")

    def do_GET(self) -> None:
        if not is_origin_allowed(self.headers.get("Origin")):
            self._write_json(ORIGIN_REJECT_STATUS, {"error": "origin is not allowed"})
            return
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/healthz":
            self._write_json(HTTPStatus.OK, {"ok": True, "liveConfigured": bool(API_KEY)})
            return
        if parsed.path == "/config":
            self._write_json(HTTPStatus.OK, {"model": MODEL, "liveConfigured": bool(API_KEY)})
            return
        if parsed.path == self.CONVERSATIONS_PATH:
            self._write_json(HTTPStatus.OK, self._conv_store)
            return
        if parsed.path in {"/", "/index.html"}:
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self) -> None:
        if not is_origin_allowed(self.headers.get("Origin")):
            self._write_json(ORIGIN_REJECT_STATUS, {"error": "origin is not allowed"})
            return
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == self.CONVERSATIONS_PATH:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length > 10 * 1024 * 1024:
                self._write_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "too large"})
                return
            body = self.rfile.read(content_length)
            try:
                data = json.loads(body.decode("utf-8"))
                if isinstance(data, list):
                    self.__class__._conv_store = data
                    self.__class__._save_conv_store()
            except Exception as err:
                sys.stderr.write(f"[serve] conv POST error: {err}\n")
            self._write_json(HTTPStatus.OK, {"ok": True})
            return
        if parsed.path not in ALLOWED_API_PATHS:
            self._write_json(HTTPStatus.NOT_FOUND, {"error": "endpoint is not allowed"})
            return
        self._proxy_api(parsed.path)

    def _proxy_api(self, path: str) -> None:
        if not API_KEY:
            self._write_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": "OPENAI_API_KEY is not configured. Demo mode still works."},
            )
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": "invalid Content-Length"})
            return

        if content_length > MAX_UPLOAD_BYTES:
            self._write_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "request body is too large"})
            return

        body = self.rfile.read(content_length) if content_length else b""
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": "invalid JSON body"})
            return

        prompt = payload.get("prompt")
        if not isinstance(prompt, str) or len(prompt) > MAX_PROMPT_CHARS:
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": f"prompt must be a string of at most {MAX_PROMPT_CHARS} characters"})
            return

        upstream_url = build_upstream_url(BASE_URL, path)
        req = urllib.request.Request(
            upstream_url,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {API_KEY}",
                "Content-Type": sanitize_content_type(self.headers.get("Content-Type")),
                "User-Agent": "Mozilla/5.0 Image2VoiceStudio/1.0",
            },
        )
        try:
            with request_with_retry(req, UPSTREAM_TIMEOUT_SECONDS) as resp:
                data = resp.read()
                content_type = resp.headers.get("Content-Type", "application/json; charset=utf-8")
                self._write(resp.status, data, content_type)
        except urllib.error.HTTPError as err:
            data = err.read() or json_bytes({"error": f"upstream HTTP {err.code}"})
            self._write(err.code, data, err.headers.get("Content-Type", "application/json; charset=utf-8"))
        except Exception as err:
            sys.stderr.write(f"[serve] proxy error: {err}\n")
            self._write_json(HTTPStatus.BAD_GATEWAY, {"error": "upstream request failed"})


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    Handler._load_conv_store()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://127.0.0.1:{PORT}/"
    print(f"[serve] {url}")
    print(f"[serve] root = {ROOT}")
    print(f"[serve] base_url = {BASE_URL}")
    print(f"[serve] live api = {'configured' if API_KEY else 'not configured; demo mode available'}")
    print("[serve] Ctrl+C to stop")
    if "--no-open" not in sys.argv:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[serve] bye")


if __name__ == "__main__":
    main()
