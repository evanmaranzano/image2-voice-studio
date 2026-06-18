const DEFAULT_BASE_URL = "";
const DEFAULT_MODEL = "gpt-image-2";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_PROMPT_CHARS = 4000;
const IMAGE_PATH = "/v1/images/generations";

import { buildUpstreamUrl } from "../../shared/utils.js";

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

  return json({ error: "not found" }, 404, req);
};

export const config = {
  path: ["/config", "/healthz", "/v1/images/generations"],
  method: ["GET", "POST", "OPTIONS"],
  preferStatic: true,
};

async function proxyImage(req) {
  const apiKey = env("OPENAI_API_KEY");
  if (!apiKey) {
    return json({ error: "OPENAI_API_KEY is not configured" }, 503, req);
  }

  const contentLength = Number(req.headers.get("content-length") || "0");
  if (contentLength > MAX_UPLOAD_BYTES) {
    return json({ error: "request body is too large" }, 413, req);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400, req);
  }

  if (typeof body.prompt !== "string" || body.prompt.length > MAX_PROMPT_CHARS) {
    return json({ error: `prompt must be a string of at most ${MAX_PROMPT_CHARS} characters` }, 400, req);
  }

  try {
    const response = await fetch(buildUpstreamUrl(env("OPENAI_BASE_URL") || DEFAULT_BASE_URL, IMAGE_PATH), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 Image2VoiceStudio/1.0",
      },
      body: JSON.stringify(body),
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
  const configured = parseAllowedOrigins();
  if (!configured.length) return false;
  return configured.includes(origin.replace(/\/$/, ""));
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
