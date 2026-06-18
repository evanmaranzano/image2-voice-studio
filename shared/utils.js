/**
 * Shared utilities for worker.js and proxy.mjs.
 *
 * These functions are pure (no platform-specific APIs) and must behave
 * identically across all JS backends. Keep serve.py's Python equivalents
 * in sync — see inline "# CQ-09 sync" markers.
 */

export function buildUpstreamUrl(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/$/, "");
  if (base.endsWith("/v1") && path.startsWith("/v1/")) {
    return `${base}${path.slice(3)}`;
  }
  return `${base}${path}`;
}
