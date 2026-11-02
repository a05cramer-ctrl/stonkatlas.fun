// Stateless buy-transaction builder. The user (account) is fee payer and only signer; nothing is signed here.
import {
  ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { connection } from "./rpc.js";
import { getToken } from "./stonkfun.js";
import { HttpError } from "./http.js";
import { loadPool, quoteBuy, buildBuyIxs, transferFeeFromPre, NATIVE_MINT } from "./launchlab.js";
import { jupQuote, jupSwapIxs, loadAlts } from "./jupiter.js";

const SOL = NATIVE_MINT.toBase58();
const PACKET = 1232;
export const DEFAULT_SLIP_BPS = 1500;

/** "curve-sol" | "curve-swap" | "jupiter" from a loaded pool ctx (or null). */
export function routeOf(ctx) {
  if (!ctx || ctx.status !== 0) return "jupiter";
  return ctx.mintB.equals(NATIVE_MINT) ? "curve-sol" : "curve-swap";
}

export function feeConfig() {
  const w = process.env.FEE_WALLET;
  if (!w) return null;
  let wallet;
  try { wallet = new PublicKey(w); } catch { return null; }
  const bps = Math.max(0, Math.min(1000, Number(process.env.FEE_BPS ?? 50) || 0));
  return bps > 0 ? { wallet, bps } : null;
}

function parseLamports(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0.001 || n > 1000) throw new HttpError(400, "amount must be between 0.001 and 1000 SOL");
  return BigInt(Math.round(n * 1e9));
}

function budget(units) {
  const micro = Number(process.env.PRIORITY_MICROLAMPORTS ?? 100_000);
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro }),
  ];
}

function compile(payer, blockhash, ixs, alts = []) {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts);
  const tx = new VersionedTransaction(msg);
  let size;
  try { size = tx.serialize().length; } catch { size = Infinity; }
  return { tx, size };
}

/**
 * Build the unsigned v0 buy tx.
 * @returns {{ tx: VersionedTransaction, base64, route, token, lamports, spend, feeLamports, expectedOut, minOut, size }}
 */
export async function buildBuyTx({ mint, account, amount, slipBps = DEFAULT_SLIP_BPS }) {
  let owner;
  try { owner = new PublicKey(account); } catch { throw new HttpError(400, "Invalid account"); }
  const lamports = parseLamports(amount);
  slipBps = Math.round(Number(slipBps));
  if (!Number.isFinite(slipBps) || slipBps < 1 || slipBps > 5000) throw new HttpError(400, "slip must be 1..5000 bps");

  const token = await getToken(mint);
  if (!token) throw new HttpError(400, "Unknown mint: not a StonkFun coin");

  const conn = connection();
  const fee = feeConfig();
  const feeLamports = fee ? (lamports * BigInt(fee.bps)) / 10000n : 0n;
  const spend = lamports - feeLamports;
  const feeIxs = feeLamports > 0n ? [SystemProgram.transfer({ fromPubkey: owner, toPubkey: fee.wallet, lamports: feeLamports })] : [];

  const quoteMint = token.quote.mint || SOL;
  const [ctx, { blockhash, lastValidBlockHeight }] = await Promise.all([
    loadPool(conn, mint, quoteMint).catch((e) => { if (e instanceof HttpError) throw e; return null; }),
    conn.getLatestBlockhash("confirmed"),
  ]);
  const route = routeOf(ctx);
  const mintPk = new PublicKey(mint);

  let built, expectedOut, minOut, detail = {};
  if (route === "curve-sol") {
    const q = quoteBuy(ctx, spend, slipBps);
    if (q.outNet <= 0n) throw new HttpError(400, "Amount too small for the curve");
    const { ixs } = buildBuyIxs(ctx, owner, q.amountIn, q.minAmountA, { wrapLamports: q.amountIn });
    built = compile(owner, blockhash, [...budget(200_000), ...feeIxs, ...ixs]);
    expectedOut = q.outNet; minOut = q.minAmountA;
  } else if (route === "curve-swap") {
    // leg 1 (Jupiter SOL -> quote) and leg 2 (buy_exact_in spending leg 1's guaranteed minimum) in one tx.
    const leg1Slip = Math.min(slipBps, 300);
    for (const maxAccounts of [32, 24, 16, 12]) {
      const jq = await jupQuote({ inputMint: SOL, outputMint: quoteMint, amount: spend, slippageBps: leg1Slip, maxAccounts });
      let amountB = BigInt(jq.otherAmountThreshold);
      if (ctx.feeB) amountB -= transferFeeFromPre(amountB, ctx.feeB, ctx.slot).fee ?? 0n; // quote with transfer fee
      const q = quoteBuy(ctx, amountB, slipBps);
      if (q.outNet <= 0n) throw new HttpError(400, "Amount too small for the curve");
      const j = await jupSwapIxs(jq, owner);
      const alts = await loadAlts(conn, j.alts);
      const { ixs } = buildBuyIxs(ctx, owner, q.amountIn, q.minAmountA);
      built = compile(owner, blockhash, [
        ...budget(700_000), ...feeIxs, ...j.other, ...j.setup, j.swap, ...j.cleanup, ...ixs,
      ], alts);
      expectedOut = q.outNet; minOut = q.minAmountA;
      detail = { leg1: { outAmount: jq.outAmount, otherAmountThreshold: jq.otherAmountThreshold, maxAccounts, hops: jq.routePlan?.length } };
      if (built.size <= PACKET) break;
    }
  } else {
    for (const maxAccounts of [undefined, 40, 28, 20]) {
      const jq = await jupQuote({ inputMint: SOL, outputMint: mint, amount: spend, slippageBps: slipBps, maxAccounts });
      const j = await jupSwapIxs(jq, owner);
      const alts = await loadAlts(conn, j.alts);
      built = compile(owner, blockhash, [...budget(600_000), ...feeIxs, ...j.other, ...j.setup, j.swap, ...j.cleanup], alts);
      expectedOut = BigInt(jq.outAmount); minOut = BigInt(jq.otherAmountThreshold);
      detail = { maxAccounts, hops: jq.routePlan?.length };
      if (built.size <= PACKET) break;
    }
  }
  if (!built || built.size > PACKET) throw new HttpError(500, "Could not fit the swap into one transaction, try another amount");

  return {
    tx: built.tx,
    base64: Buffer.from(built.tx.serialize()).toString("base64"),
    size: built.size,
    route, token, lamports, spend, feeLamports, expectedOut, minOut, lastValidBlockHeight, detail,
    mint: mintPk.toBase58(),
  };
}
