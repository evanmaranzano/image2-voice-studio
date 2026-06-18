const DEFAULT_BASE_URL = "";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_API_PATHS = new Set(["/v1/images/generations"]);
const MAX_PROMPT_CHARS = 4000;
const ALLOWED_ORIGINS = "ALLOWED_ORIGINS";

import { buildUpstreamUrl } from "./shared/utils.js";

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
