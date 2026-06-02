import { getStore } from "@netlify/blobs";

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function env(name) {
  return globalThis.Netlify?.env?.get?.(name) || globalThis.process?.env?.[name] || "";
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
  if (!configured.length) return true;
  return configured.includes(origin.replace(/\/$/, ""));
}

function corsHeaders(req) {
  const origin = req.headers.get("origin") || "";
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
  };
  if (origin && isOriginAllowed(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(data, status, req) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req) },
  });
}

function unauthorized(req) {
  return json({ error: "unauthorized" }, 401, req);
}

function checkAuth(req) {
  const secret = env("CONVERSATIONS_SECRET");
  if (!secret) return true; // not configured → allow unauthenticated (exhibit/demo)
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  return token === secret;
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  const store = getStore("conversations");

  try {
    if (req.method === "GET") {
      if (!checkAuth(req)) return unauthorized(req);
      const data = await store.get("all", { type: "json" });
      return json(data || [], 200, req);
    }

    if (req.method === "POST") {
      if (!checkAuth(req)) return unauthorized(req);

      const contentLength = Number(req.headers.get("content-length") || "0");
      if (contentLength > MAX_BODY_BYTES) {
        return json({ error: "request body is too large" }, 413, req);
      }

      const buffer = await req.arrayBuffer();
      if (buffer.byteLength > MAX_BODY_BYTES) {
        return json({ error: "request body is too large" }, 413, req);
      }

      let body;
      try {
        body = JSON.parse(new TextDecoder().decode(buffer));
      } catch {
        return json({ error: "invalid JSON body" }, 400, req);
      }
      if (!Array.isArray(body)) return json({ error: "expected array" }, 400, req);
      await store.set("all", JSON.stringify(body));
      return json({ ok: true }, 200, req);
    }

    if (req.method === "DELETE") {
      if (!checkAuth(req)) return unauthorized(req);
      await store.delete("all");
      return json({ ok: true }, 200, req);
    }

    return json({ error: "method not allowed" }, 405, req);
  } catch (err) {
    return json({ error: err.message }, 500, req);
  }
};
