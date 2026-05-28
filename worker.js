const DEFAULT_BASE_URL = "https://www.packyapi.com/v1";
const DEFAULT_MIMO_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1";
const DEFAULT_MIMO_MODEL = "MiMo-V2-Omni";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_API_PATHS = new Set(["/v1/images/generations"]);
const ALLOWED_ORIGINS = "ALLOWED_ORIGINS";
const STT_PATH = "/stt/transcribe";

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

  const upstream = await fetch(buildUpstreamUrl(env.OPENAI_BASE_URL || DEFAULT_BASE_URL, url.pathname), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": request.headers.get("content-type") || "application/json",
      "User-Agent": "Mozilla/5.0 Image2VoiceStudio/1.0",
    },
    body: request.body,
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
              text: `请把这段音频转写为纯文本，只返回转写内容。音频 MIME 类型：${audio.mimeType}。优先按 ${language} 识别。`,
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
      const text = cleanText(choice?.message?.content) || cleanText(choice?.text);
      if (text) return text;
    }
  }
  return cleanText(data?.output);
}

function normalizeMimoModel(model) {
  return String(model).toLowerCase() === "mimo-v2-omni" ? "mimo-v2-omni" : model;
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
  if (isOriginAllowed(origin, env)) {
    headers["Access-Control-Allow-Origin"] = origin || "null";
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
