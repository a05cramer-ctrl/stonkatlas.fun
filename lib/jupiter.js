// Jupiter Swap API v1: quote + swap-instructions (we assemble our own v0 tx so the swap can share it with
// the LaunchLab buy, the fee transfer and our compute budget).
import { PublicKey, TransactionInstruction, AddressLookupTableAccount } from "@solana/web3.js";
import { HttpError } from "./http.js";

const BASE = () =>
  (process.env.JUP_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1");
const HEADERS = () => (process.env.JUP_API_KEY ? { "x-api-key": process.env.JUP_API_KEY } : {});

async function jfetch(url, { method = "GET", body, timeoutMs = 8000 } = {}) {
  for (let i = 0; ; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    let r, text;
    try {
      r = await fetch(url, {
        method, signal: ctl.signal,
        headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...HEADERS() },
        body: body ? JSON.stringify(body) : undefined,
      });
      text = await r.text();
    } catch (e) {
      if (i < 2) { await new Promise((s) => setTimeout(s, 400 * 2 ** i)); continue; }
      throw new HttpError(502, "Jupiter unreachable");
    } finally {
      clearTimeout(t);
    }
    if (r.ok) return JSON.parse(text);
    if ((r.status === 429 || r.status >= 500) && i < 3) { await new Promise((s) => setTimeout(s, 700 * 2 ** i)); continue; }
    if (r.status === 429) throw new HttpError(503, "Jupiter is rate limiting, try again in a few seconds");
    let msg = text.slice(0, 160);
    try { msg = JSON.parse(text).error || msg; } catch {}
    throw new HttpError(r.status === 400 ? 400 : 502, `Jupiter: ${msg}`);
  }
}

export async function jupQuote({ inputMint, outputMint, amount, slippageBps, maxAccounts }) {
  const u = new URL(BASE() + "/quote");
  u.searchParams.set("inputMint", String(inputMint));
  u.searchParams.set("outputMint", String(outputMint));
  u.searchParams.set("amount", BigInt(amount).toString());
  u.searchParams.set("slippageBps", String(slippageBps));
  u.searchParams.set("swapMode", "ExactIn");
  u.searchParams.set("restrictIntermediateTokens", "true");
  if (maxAccounts) u.searchParams.set("maxAccounts", String(maxAccounts));
  const q = await jfetch(u.toString());
  if (!q?.outAmount) throw new HttpError(400, "Jupiter: no route");
  return q;
}

const toIx = (ix) =>
  new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  });

/** Returns { setup, swap, cleanup, other, alts: [addresses] }. Compute budget ixs from Jupiter are dropped (we set our own). */
export async function jupSwapIxs(quoteResponse, userPublicKey) {
  const j = await jfetch(BASE() + "/swap-instructions", {
    method: "POST",
    timeoutMs: 10000,
    body: {
      quoteResponse,
      userPublicKey: String(userPublicKey),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: false,
    },
  });
  if (j?.error) throw new HttpError(502, `Jupiter swap-instructions: ${j.error}`);
  return {
    other: (j.otherInstructions || []).map(toIx),
    setup: (j.setupInstructions || []).map(toIx),
    swap: toIx(j.swapInstruction),
    cleanup: j.cleanupInstruction ? [toIx(j.cleanupInstruction)] : [],
    alts: j.addressLookupTableAddresses || [],
  };
}

const altCache = new Map();
export async function loadAlts(conn, addresses) {
  const want = addresses.filter((a) => !altCache.has(a));
  if (want.length) {
    const infos = await conn.getMultipleAccountsInfo(want.map((a) => new PublicKey(a)));
    want.forEach((a, i) => {
      if (infos[i]) altCache.set(a, new AddressLookupTableAccount({ key: new PublicKey(a), state: AddressLookupTableAccount.deserialize(infos[i].data) }));
    });
  }
  return addresses.map((a) => altCache.get(a)).filter(Boolean);
}
