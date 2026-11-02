// StonkFun public API (apex domain; www. 301-redirects).
import { HttpError } from "./http.js";

export const SF_ORIGIN = "https://stonkfun.xyz";
const API = `${SF_ORIGIN}/api/public/v1`;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const isMint = (s) => typeof s === "string" && B58.test(s);
const abs = (u) => (!u ? null : /^https?:\/\//i.test(u) ? u.replace(/^http:/i, "https:") : SF_ORIGIN + (u.startsWith("/") ? u : "/" + u));

async function sfGet(path, timeoutMs = 7000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(API + path, { headers: { accept: "application/json" }, signal: ctl.signal, redirect: "follow" });
    if (r.status === 404) return null;
    if (!r.ok) throw new HttpError(502, `StonkFun API ${r.status}`);
    return await r.json();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, "StonkFun API unreachable");
  } finally {
    clearTimeout(t);
  }
}

/** Normalized coin record, or null when StonkFun doesn't know the mint. */
export async function getToken(mint) {
  if (!isMint(mint)) throw new HttpError(400, "Invalid mint address");
  const j = await sfGet(`/tokens/${mint}`);
  const t = j?.data?.token;
  if (!t || t.mint !== mint) return null;
  return normalize(t, j?.data?.launch);
}

export async function getTrending(n = 24) {
  const j = await sfGet(`/tokens?sort=volume&pageSize=${Math.min(Math.max(n, 1), 50)}`);
  return (j?.data?.tokens || []).map((t) => normalize(t));
}

export function normalize(t, launch) {
  const m = t.market || {};
  const q = t.quote || {};
  return {
    mint: t.mint,
    pool: t.pool || null,
    name: t.name || "",
    sym: t.symbol || "",
    img: abs(t.imageUrl || launch?.logoUrl),
    quote: { sym: q.symbol || "", mint: q.mint || "", logo: abs(q.logoUrl) },
    mcap: num(m.marketCapUsd),
    vol24: num(m.volume24hUsd),
    price: num(m.priceUsd),
    change24: num(m.priceChange24h),
    liquidity: num(m.liquidityUsd),
    status: t.status || null,
    graduated: t.status === "graduated" || Number(t.graduationProgress) >= 1,
    progress: num(t.graduationProgress),
    mode: t.mode || null,
    transferFeeBps: t.transferFee?.bps ?? null,
    createdAt: t.createdAt || launch?.createdAt || null,
    creator: launch?.creator || null,
  };
}
const num = (x) => (x === undefined || x === null || Number.isNaN(Number(x)) ? null : Number(x));

export function fmtUsd(n) {
  if (n == null) return "?";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
