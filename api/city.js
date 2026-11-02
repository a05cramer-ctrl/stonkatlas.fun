// GET /api/city — every StonkFun coin worth drawing: top 400 by 24h volume, top 100 by market cap,
// newest 100. Compact rows for the 3D city. No env vars. Edge-cached 15 s.
const SF = "https://stonkfun.xyz/api/public/v1";
const abs = (u) => (!u ? "" : u.startsWith("/") ? "https://stonkfun.xyz" + u : u);
async function page(q) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(`${SF}/tokens?${q}`, { headers: { accept: "application/json" } }); if (r.ok) return (await r.json())?.data?.tokens || []; }
    catch {}
    await new Promise((r) => setTimeout(r, 300 * (i + 1)));
  }
  return [];
}
export default async function handler(req, res) {
  const lists = await Promise.all([
    page("sort=volume&pageSize=100&page=1"), page("sort=volume&pageSize=100&page=2"),
    page("sort=volume&pageSize=100&page=3"), page("sort=volume&pageSize=100&page=4"),
    page("sort=mcap&pageSize=100&page=1"), page("sort=newest&pageSize=100&page=1"),
  ]);
  const seen = new Map();
  lists.flat().forEach((t) => {
    if (!t?.mint || seen.has(t.mint)) return;
    const m = t.market || {};
    seen.set(t.mint, {
      mint: t.mint, sym: t.symbol, name: t.name, img: abs(t.imageUrl),
      q: t.quote?.symbol || "SOL", ql: abs(t.quote?.logoUrl), qc: t.quote?.categoryLabel || "",
      mc: Math.round(m.marketCapUsd || 0), vol: Math.round(m.volume24hUsd || 0), ch: m.priceChange24h ?? null,
      st: t.status, ts: t.createdAt,
    });
  });
  res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json({ at: Date.now(), coins: [...seen.values()] });
}
