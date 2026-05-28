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
import base64
import binascii
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
        return
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
BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://www.packyapi.com/v1").rstrip("/")
MODEL = os.environ.get("OPENAI_MODEL", "gpt-image-2").strip() or "gpt-image-2"
ALLOWED_API_PATHS = {"/v1/images/generations"}
STT_PATH = "/stt/transcribe"
MIMO_API_KEY = os.environ.get("MIMO_API_KEY", "").strip()
MIMO_BASE_URL = os.environ.get("MIMO_BASE_URL", "https://token-plan-cn.xiaomimimo.com/v1").rstrip("/")
MIMO_MODEL = os.environ.get("MIMO_MODEL", "MiMo-V2-Omni").strip() or "MiMo-V2-Omni"
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_AUDIO_BYTES = MAX_UPLOAD_BYTES
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


def build_upstream_url(base_url: str, path: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/v1") and path.startswith("/v1/"):
        return base + path[3:]
    return base + path


def parse_audio_data_url(data_url: str) -> tuple[str, str, bytes]:
    if not isinstance(data_url, str) or not data_url.startswith("data:"):
        raise ValueError("audioData must be a data URL")
    try:
        header, encoded = data_url.split(",", 1)
    except ValueError as err:
        raise ValueError("audioData is missing base64 data") from err

    parts = [part.strip().lower() for part in header[5:].split(";") if part.strip()]
    mime_type = parts[0] if parts else ""
    if not mime_type.startswith("audio/"):
        raise ValueError("audioData must be an audio data URL")
    if "base64" not in parts[1:]:
        raise ValueError("audioData must be base64 encoded")

    try:
        audio_bytes = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as err:
        raise ValueError("audioData base64 is invalid") from err
    if not audio_bytes:
        raise ValueError("audioData is empty")

    subtype = mime_type.split("/", 1)[1].split("+", 1)[0]
    audio_format = {
        "mpeg": "mp3",
        "mp3": "mp3",
        "wav": "wav",
        "x-wav": "wav",
        "wave": "wav",
        "webm": "webm",
        "ogg": "ogg",
        "mp4": "mp4",
        "m4a": "m4a",
    }.get(subtype, subtype)
    return mime_type, audio_format, audio_bytes


def _clean_text(value: object) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        chunks: list[str] = []
        for item in value:
            text = _clean_text(item)
            if text:
                chunks.append(text)
        return "\n".join(chunks).strip()
    if isinstance(value, dict):
        for key in ("text", "transcript", "content", "reasoning_content"):
            text = _clean_text(value.get(key))
            if text:
                return text
    return ""


def extract_transcript(data: dict) -> str:
    for key in ("text", "transcript", "output_text"):
        text = _clean_text(data.get(key))
        if text:
            return text

    choices = data.get("choices")
    if isinstance(choices, list):
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            message = choice.get("message")
            text = _clean_text(message if isinstance(message, dict) else None)
            if text:
                return text
            text = _clean_text(choice.get("text"))
            if text:
                return text

    output = data.get("output")
    if isinstance(output, list):
        text = _clean_text(output)
        if text:
            return text
    return ""


def normalize_mimo_model(model: str) -> str:
    if model.lower() == "mimo-v2-omni":
        return "mimo-v2-omni"
    return model


def sanitize_content_type(content_type: str | None, path: str) -> str:
    if content_type and content_type.startswith("application/json"):
        return "application/json"
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
        if parsed.path in {"/", "/index.html"}:
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self) -> None:
        if not is_origin_allowed(self.headers.get("Origin")):
            self._write_json(ORIGIN_REJECT_STATUS, {"error": "origin is not allowed"})
            return
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == STT_PATH:
            self._proxy_stt()
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
        upstream_url = build_upstream_url(BASE_URL, path)
        req = urllib.request.Request(
            upstream_url,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {API_KEY}",
                "Content-Type": sanitize_content_type(self.headers.get("Content-Type"), path),
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
            self._write_json(HTTPStatus.BAD_GATEWAY, {"error": f"local proxy: {err}"})

    def _proxy_stt(self) -> None:
        if not MIMO_API_KEY:
            self._write_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": "MIMO_API_KEY is not configured. Browser speech still works if supported."},
            )
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": "invalid Content-Length"})
            return

        if content_length > MAX_UPLOAD_BYTES * 2:
            self._write_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "request body is too large"})
            return

        body = self.rfile.read(content_length) if content_length else b""
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": "invalid JSON body"})
            return

        try:
            data_url = str(payload.get("audioData") or "")
            mime_type, audio_format, audio_bytes = parse_audio_data_url(data_url)
        except ValueError as err:
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(err)})
            return

        if len(audio_bytes) > MAX_AUDIO_BYTES:
            self._write_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "audio is too large"})
            return

        language = str(payload.get("lang") or "zh-CN")
        prompt = (
            "请把这段音频转写为纯文本，只返回转写内容。"
            f"音频 MIME 类型：{mime_type}。优先按 {language} 识别。"
        )
        upstream_payload = {
            "model": normalize_mimo_model(MIMO_MODEL),
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "input_audio", "input_audio": {"data": data_url, "format": audio_format}},
                    ],
                }
            ],
        }
        req = urllib.request.Request(
            build_upstream_url(MIMO_BASE_URL, "/v1/chat/completions"),
            data=json_bytes(upstream_payload),
            method="POST",
            headers={
                "Authorization": f"Bearer {MIMO_API_KEY}",
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 Image2VoiceStudio/1.0",
            },
        )
        try:
            with request_with_retry(req, UPSTREAM_TIMEOUT_SECONDS) as resp:
                raw = resp.read()
                data = json.loads(raw.decode("utf-8"))
                transcript = extract_transcript(data)
                if not transcript:
                    self._write_json(HTTPStatus.BAD_GATEWAY, {"error": "MiMo response did not contain transcript"})
                    return
                self._write_json(HTTPStatus.OK, {"text": transcript, "provider": "MiMo-V2-Omni"})
        except urllib.error.HTTPError as err:
            data = err.read() or json_bytes({"error": f"MiMo upstream HTTP {err.code}"})
            self._write(err.code, data, err.headers.get("Content-Type", "application/json; charset=utf-8"))
        except Exception as err:
            self._write_json(HTTPStatus.BAD_GATEWAY, {"error": f"MiMo proxy: {err}"})

class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
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
