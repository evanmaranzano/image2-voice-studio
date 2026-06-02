/**
 * Shared utilities for worker.js and proxy.mjs.
 *
 * These functions are pure (no platform-specific APIs) and must behave
 * identically across all JS backends. Keep serve.py's Python equivalents
 * in sync — see inline "# CQ-09 sync" markers.
 */

export const FORMAT_MAP = {
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

export const ALLOWED_AUDIO_TYPES = new Set([
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave",
  "audio/webm", "audio/ogg", "audio/mp4", "audio/x-m4a", "audio/m4a",
  "audio/aac", "audio/flac", "audio/x-flac", "audio/opus",
]);

export function buildUpstreamUrl(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/$/, "");
  if (base.endsWith("/v1") && path.startsWith("/v1/")) {
    return `${base}${path.slice(3)}`;
  }
  return `${base}${path}`;
}

export function parseAudioDataUrl(dataUrl) {
  if (!dataUrl.startsWith("data:")) throw new Error("audioData must be a data URL");
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) throw new Error("audioData is missing base64 data");
  const header = dataUrl.slice(5, commaIndex);
  const data = dataUrl.slice(commaIndex + 1);
  const parts = header
    .split(";")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const mimeType = parts[0] || "";
  if (!mimeType.startsWith("audio/")) throw new Error("audioData must be an audio data URL");
  if (!ALLOWED_AUDIO_TYPES.has(mimeType)) throw new Error(`unsupported audio MIME type: ${mimeType}`);
  if (!parts.slice(1).includes("base64")) throw new Error("audioData must be base64 encoded");
  if (!data) throw new Error("audioData is empty");

  const byteLength =
    Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  const subtype = mimeType.split("/")[1].split("+")[0];
  return { mimeType, format: FORMAT_MAP[subtype] || subtype, data, byteLength };
}

export function cleanText(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value))
    return value
      .map(cleanText)
      .filter(Boolean)
      .join("\n")
      .trim();
  if (value && typeof value === "object") {
    return (
      cleanText(value.text) ||
      cleanText(value.transcript) ||
      cleanText(value.content) ||
      cleanText(value.reasoning_content)
    );
  }
  return "";
}

export function extractTranscript(data) {
  const direct = cleanText(data?.text) || cleanText(data?.transcript) || cleanText(data?.output_text);
  if (direct) return direct;
  if (Array.isArray(data?.choices)) {
    for (const choice of data.choices) {
      const content = choice?.message?.content;
      if (typeof content === "string") {
        const t = content.trim();
        if (t) return t;
      }
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

export function normalizeMimoModel(model) {
  return String(model).toLowerCase() === "mimo-v2-omni" ? "mimo-v2-omni" : model;
}
