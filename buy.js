// POST /api/buy?mint=&amount=  body {account} → unsigned v0 buy tx (same router as BEACON:
// SOL-pair curve buy, swap-into-pair + curve buy, or Jupiter for graduated coins).
import { send, getQuery, getBody, HttpError } from "../lib/http.js";
import { isMint } from "../lib/stonkfun.js";
import { buildBuyTx } from "../lib/buy.js";

export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") return send(res, 200, {});
    if (req.method !== "POST") throw new HttpError(405, "POST only");
    const q = getQuery(req);
    const mint = String(q.mint || "").trim();
    if (!isMint(mint)) throw new HttpError(400, "Invalid mint address");
    const amount = Number(q.amount);
    if (!(amount > 0) || amount > 50) throw new HttpError(400, "Amount must be between 0 and 50 SOL");
    const body = await getBody(req);
    const account = String(body.account || "");
    if (!isMint(account)) throw new HttpError(400, "Invalid account");
    const out = await buildBuyTx({ mint, account, amount, slipBps: q.slip ? Number(q.slip) : undefined });
    send(res, 200, out);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (!(e instanceof HttpError)) console.error("[buy]", e);
    send(res, status, { message: e instanceof HttpError ? e.message : "Could not build the trade" });
  }
}
