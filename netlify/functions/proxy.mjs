const DEFAULT_BASE_URL = "https://api.change2pro.com";
const DEFAULT_MODEL = "gpt-image-2";
const DEFAULT_MIMO_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1";
const DEFAULT_MIMO_MODEL = "MiMo-V2-Omni";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_STT_BODY_BYTES = MAX_UPLOAD_BYTES * 2;
const IMAGE_PATH = "/v1/images/generations";
const STT_PATH = "/stt/transcribe";
const ALLOWED_LANGS = new Set(["zh-CN", "en-US", "ja-JP", "zh-TW", "ko-KR", "fr-FR", "de-DE", "es-ES"]);

export default async (req) => {
  const url = new URL(req.url);
  const fallbackRoute = getFallbackRoute(url);

  if (!isOriginAllowed(req.headers.get("origin"))) {
    return json({ error: "origin is not allowed" }, 403, req);
  }

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  if (req.method === "GET" && (url.pathname === "/config" || fallbackRoute === "config")) {
    return json(
      {
        model: env("OPENAI_MODEL") || DEFAULT_MODEL,
        liveConfigured: Boolean(env("OPENAI_API_KEY")),
      },
      200,
      req,
    );
  }

  if (req.method === "GET" && (url.pathname === "/healthz" || fallbackRoute === "healthz")) {
    return json({ ok: true, liveConfigured: Boolean(env("OPENAI_API_KEY")) }, 200, req);
  }

  if (req.method === "POST" && (url.pathname === IMAGE_PATH || fallbackRoute === "generate")) {
    return proxyImage(req);
  }

  if (req.method === "POST" && (url.pathname === STT_PATH || fallbackRoute === "transcribe")) {
    return proxyStt(req);
  }

  return json({ error: "not found" }, 404, req);
};

export const config = {
  path: ["/config", "/healthz", "/v1/images/generations", "/stt/transcribe"],
  method: ["GET", "POST", "OPTIONS"],
  preferStatic: true,
};

async function proxyImage(req) {
  const apiKey = env("OPENAI_API_KEY");
  if (!apiKey) {
    return json({ error: "OPENAI_API_KEY is not configured" }, 503, req);
  }

  const body = await readBody(req, MAX_UPLOAD_BYTES);
  if (body.error) {
    return json({ error: body.error }, body.status, req);
  }

  try {
    const response = await fetch(buildUpstreamUrl(env("OPENAI_BASE_URL") || DEFAULT_BASE_URL, IMAGE_PATH), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": req.headers.get("content-type") || "application/json",
        "User-Agent": "Mozilla/5.0 Image2VoiceStudio/1.0",
      },
      body: body.buffer,
    });

    const raw = await response.text();
    return new Response(raw, {
      status: response.status,
      headers: {
        ...corsHeaders(req),
        "Content-Type": response.headers.get("content-type") || "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return json({ error: "image proxy failed" }, 502, req);
  }
}

async function proxyStt(req) {
  const apiKey = env("MIMO_API_KEY");
  if (!apiKey) {
    return json({ error: "MIMO_API_KEY is not configured" }, 503, req);
  }

  const body = await readBody(req, MAX_STT_BODY_BYTES);
  if (body.error) {
    return json({ error: body.error }, body.status, req);
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(body.buffer));
  } catch {
    return json({ error: "invalid JSON body" }, 400, req);
  }

  let audio;
  try {
    audio = parseAudioDataUrl(String(payload.audioData || ""));
  } catch (error) {
    return json({ error: error.message }, 400, req);
  }

  if (audio.byteLength > MAX_UPLOAD_BYTES) {
    return json({ error: "audio is too large" }, 413, req);
  }

  const language = String(payload.lang || "zh-CN");
  if (!ALLOWED_LANGS.has(language)) {
    return json({ error: "unsupported language code" }, 400, req);
  }
  const upstream = await fetch(buildUpstreamUrl(env("MIMO_BASE_URL") || DEFAULT_MIMO_BASE_URL, "/v1/chat/completions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 Image2VoiceStudio/1.0",
    },
    body: JSON.stringify({
      model: normalizeMimoModel(env("MIMO_MODEL") || DEFAULT_MIMO_MODEL),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `请把这段音频转写为纯文本，只返回转写内容。音频 MIME 类型：${audio.mimeType}。优先按 ${language} 识别。`,
            },
            {
              type: "input_audio",
              input_audio: { data: payload.audioData, format: audio.format },
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
        ...corsHeaders(req),
        "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json({ error: "MiMo response was not JSON" }, 502, req);
  }

  const transcript = extractTranscript(data);
  if (!transcript) {
    return json({ error: "MiMo response did not contain transcript" }, 502, req);
  }

  return json({ text: transcript, provider: DEFAULT_MIMO_MODEL }, 200, req);
}

async function readBody(req, maxBytes) {
  const contentLength = Number(req.headers.get("content-length") || "0");
  if (contentLength > maxBytes) {
    return { error: "request body is too large", status: 413 };
  }

  const buffer = await req.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    return { error: "request body is too large", status: 413 };
  }

  return { buffer };
}

function env(name) {
  return globalThis.Netlify?.env?.get?.(name) || globalThis.process?.env?.[name] || "";
}

function getFallbackRoute(url) {
  if (!url.pathname.endsWith("/.netlify/functions/proxy")) return "";
  return String(url.searchParams.get("route") || "").trim().toLowerCase();
}

function parseAllowedOrigins() {
  return env("ALLOWED_ORIGINS")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function isOriginAllowed(origin) {
  if (!origin) return true;
  const allowed = parseAllowedOrigins();
  if (!allowed.length) return false;
  return allowed.includes(origin.replace(/\/$/, ""));
}

function corsHeaders(req) {
  const origin = req.headers.get("origin") || "";
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  if (origin && isOriginAllowed(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function buildUpstreamUrl(baseUrl, path) {
  const base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  if (base.endsWith("/v1") && path.startsWith("/v1/")) {
    return `${base}${path.slice(3)}`;
  }
  return `${base}${path}`;
}

function parseAudioDataUrl(dataUrl) {
  if (!dataUrl.startsWith("data:")) throw new Error("audioData must be a data URL");
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) throw new Error("audioData is missing base64 data");
  const header = dataUrl.slice(5, commaIndex);
  const data = dataUrl.slice(commaIndex + 1);
  const parts = header.split(";").map((part) => part.trim().toLowerCase()).filter(Boolean);
  const mimeType = parts[0] || "";
  if (!mimeType.startsWith("audio/")) throw new Error("audioData must be an audio data URL");
  if (!parts.slice(1).includes("base64")) throw new Error("audioData must be base64 encoded");
  if (!data) throw new Error("audioData is empty");

  const byteLength = Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  const subtype = mimeType.split("/")[1].split("+")[0];
  const formatMap = {
    mpeg: "mp3",
    mp3: "mp3",
    wav: "wav",
    "x-wav": "wav",
    wave: "wav",
    webm: "webm",
    ogg: "ogg",
    mp4: "mp4",
    m4a: "m4a",
  };
  return { mimeType, format: formatMap[subtype] || subtype, data, byteLength };
}

function cleanText(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean).join("\n").trim();
  if (value && typeof value === "object") {
    return cleanText(value.text) || cleanText(value.transcript) || cleanText(value.content) || cleanText(value.reasoning_content);
  }
  return "";
}

function extractTranscript(data) {
  const direct = cleanText(data?.text) || cleanText(data?.transcript) || cleanText(data?.output_text);
  if (direct) return direct;
  if (Array.isArray(data?.choices)) {
    for (const choice of data.choices) {
      const content = choice?.message?.content;
      if (typeof content === "string") { const t = content.trim(); if (t) return t; }
      if (Array.isArray(content)) {
        for (const part of content) {
          const t = cleanText(part?.text) || cleanText(part?.transcript);
          if (t) return t;
        }
      }
      const rc = cleanText(choice?.message?.reasoning_content);
      if (rc) return rc;
      const ct = cleanText(choice?.text);
      if (ct) return ct;
    }
  }
  return cleanText(data?.output);
}

function normalizeMimoModel(model) {
  return String(model).toLowerCase() === "mimo-v2-omni" ? "mimo-v2-omni" : model;
}

function json(payload, status, req) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
