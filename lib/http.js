// Tiny response helpers shared by every function. Works with Vercel's Node runtime (req.query / req.body
// may be pre-parsed) and with a bare node:http req/res (we parse the URL and body ourselves).

export const ACTION_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding",
  "X-Action-Version": "2.4",
  "X-Blockchain-Ids": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "Content-Type": "application/json",
};

export function send(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  for (const [k, v] of Object.entries({ ...ACTION_HEADERS, ...extraHeaders })) res.setHeader(k, v);
  res.end(body === undefined ? "" : JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export function getQuery(req) {
  if (req.query && typeof req.query === "object") return req.query;
  const u = new URL(req.url || "/", "http://localhost");
  return Object.fromEntries(u.searchParams.entries());
}

export async function getBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
    if (Buffer.isBuffer(req.body)) { try { return JSON.parse(req.body.toString("utf8")); } catch { return {}; } }
    return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) break;
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
}

/** Absolute origin of this deployment, used for absolute hrefs. */
export function origin(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/+$/, "");
  const h = req.headers || {};
  const host = h["x-forwarded-host"] || h.host || "localhost";
  const proto = (h["x-forwarded-proto"] || (String(host).startsWith("localhost") ? "http" : "https")).split(",")[0];
  return `${proto}://${host}`;
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
