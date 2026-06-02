const DEFAULT_BASE_URL = "";
const DEFAULT_MIMO_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1";
const DEFAULT_MIMO_MODEL = "MiMo-V2-Omni";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_API_PATHS = new Set(["/v1/images/generations"]);
const MAX_PROMPT_CHARS = 4000;
const ALLOWED_ORIGINS = "ALLOWED_ORIGINS";
const STT_PATH = "/stt/transcribe";
const ALLOWED_LANGS = new Set(["zh-CN", "en-US", "ja-JP", "zh-TW", "ko-KR", "fr-FR", "de-DE", "es-ES"]);

// CQ-09: shared pure utilities — keep in sync with serve.py
import { buildUpstreamUrl, parseAudioDataUrl, cleanText, extractTranscript, normalizeMimoModel } from "./shared/utils.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!isOriginAllowed(request.headers.get("origin") || "", env)) {
      return rejectDisallowedOrigin(request, env);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true, liveConfigured: Boolean(env.OPENAI_API_KEY) }, 200, request, env);
    }

    if (request.method === "GET" && url.pathname === "/config") {
      return json({ model: env.OPENAI_MODEL || "gpt-image-2", liveConfigured: Boolean(env.OPENAI_API_KEY) }, 200, request, env);
    }

    if (request.method === "POST" && ALLOWED_API_PATHS.has(url.pathname)) {
      return proxyImageApi(request, env, url);
    }

    if (request.method === "POST" && url.pathname === STT_PATH) {
      return proxyStt(request, env);
    }

    return json({ error: "not found" }, 404, request, env);
  },
};

async function proxyImageApi(request, env, url) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return json({ error: "OPENAI_API_KEY is not configured on the worker" }, 503, request, env);
  }

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_UPLOAD_BYTES) {
    return json({ error: "request body is too large" }, 413, request, env);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400, request, env);
  }

  if (typeof body.prompt !== "string" || body.prompt.length > MAX_PROMPT_CHARS) {
    return json({ error: `prompt must be a string of at most ${MAX_PROMPT_CHARS} characters` }, 400, request, env);
  }

  const upstream = await fetch(buildUpstreamUrl(env.OPENAI_BASE_URL || DEFAULT_BASE_URL, url.pathname), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 Image2VoiceStudio/1.0",
    },
    body: JSON.stringify(body),
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...corsHeaders(request, env),
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function proxyStt(request, env) {
  const apiKey = env.MIMO_API_KEY;
  if (!apiKey) {
    return json({ error: "MIMO_API_KEY is not configured on the worker" }, 503, request, env);
  }

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_UPLOAD_BYTES * 2) {
    return json({ error: "request body is too large" }, 413, request, env);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400, request, env);
  }

  let audio;
  try {
    audio = parseAudioDataUrl(String(body.audioData || ""));
  } catch (error) {
    return json({ error: error.message }, 400, request, env);
  }

  if (audio.byteLength > MAX_UPLOAD_BYTES) {
    return json({ error: "audio is too large" }, 413, request, env);
  }

  const language = String(body.lang || "zh-CN");
  if (!ALLOWED_LANGS.has(language)) {
    return json({ error: "unsupported language code" }, 400, request, env);
  }
  const upstream = await fetch(buildUpstreamUrl(env.MIMO_BASE_URL || DEFAULT_MIMO_BASE_URL, "/v1/chat/completions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 Image2VoiceStudio/1.0",
    },
    body: JSON.stringify({
      model: normalizeMimoModel(env.MIMO_MODEL || DEFAULT_MIMO_MODEL),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `请把这段音频转写为纯文本，只返回转写内容。音频 MIME 类型：${audio.mimeType.split(";")[0].trim()}。优先按 ${language} 识别。`,
            },
            {
              type: "input_audio",
              input_audio: { data: body.audioData, format: audio.format },
            },
          ],
        },
      ],
    }),
  });

  const raw = await upstream.text();
  if (!upstream.ok) {
    return new Response(raw || JSON.stringify({ error: `MiMo upstream HTTP ${upstream.status}` }), {
      status: upstream.status,
      headers: {
        ...corsHeaders(request, env),
        "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json({ error: "MiMo response was not JSON" }, 502, request, env);
  }

  const transcript = extractTranscript(data);
  if (!transcript) {
    return json({ error: "MiMo response did not contain transcript" }, 502, request, env);
  }
  return json({ text: transcript, provider: DEFAULT_MIMO_MODEL }, 200, request, env);
}

function parseAllowedOrigins(env) {
  return String(env[ALLOWED_ORIGINS] || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function isOriginAllowed(origin, env) {
  if (!origin) return true;
  return parseAllowedOrigins(env).includes(origin.replace(/\/$/, ""));
}

function rejectDisallowedOrigin(request, env) {
  return json({ error: "origin is not allowed" }, 403, request, env);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  if (origin && isOriginAllowed(origin, env)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return {
    ...headers,
  };
}

function json(payload, status, request, env) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(request, env),
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
