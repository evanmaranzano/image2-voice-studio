import { getStore } from "@netlify/blobs";

function corsHeaders(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status, req) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req) },
  });
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  const store = getStore("conversations");

  try {
    if (req.method === "GET") {
      const data = await store.get("all", { type: "json" });
      return json(data || [], 200, req);
    }

    if (req.method === "POST") {
      const body = await req.json();
      if (!Array.isArray(body)) return json({ error: "expected array" }, 400, req);
      await store.set("all", JSON.stringify(body));
      return json({ ok: true }, 200, req);
    }

    if (req.method === "DELETE") {
      await store.delete("all");
      return json({ ok: true }, 200, req);
    }

    return json({ error: "method not allowed" }, 405, req);
  } catch (err) {
    return json({ error: err.message }, 500, req);
  }
};

export const config = { path: "/conversations" };
