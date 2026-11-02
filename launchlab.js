// Raydium LaunchLab (StonkFun) — stateless, SDK-free port.
// Instruction bytes: buyExactInIx / createAtaIdempotentIx / pdas copied from vanguard/engine/launch.js
//   (byte-matched to raydium-sdk-v2 buyExactInInstruction earlier).
// Account layouts: hand-decoded at the offsets of sdk LaunchpadPool / LaunchpadConfig / PlatformConfig.
// Curve math: BigInt port of sdk Curve.buyExactIn + LaunchConstantProductCurve + transfer-fee helpers
//   (verified against the SDK in test/xcheck-curve.mjs).
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

export const LAUNCHLAB_PROGRAM = new PublicKey("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const POOL_STATUS = { 0: "trading", 1: "migrating", 2: "migrated" };

const DISC_BUY_EXACT_IN = [250, 234, 13, 123, 213, 156, 19, 236];
const FEE_DENOM = 1_000_000n;
const POINT = 10_000n;

// ---------- PDAs (sdk pda.ts) ----------
const s = (x) => Buffer.from(x, "utf8");
const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0];
export const pdas = {
  auth: (p) => pda([s("vault_auth_seed")], p),
  pool: (p, mintA, mintB) => pda([s("pool"), mintA.toBuffer(), mintB.toBuffer()], p),
  cpiEvent: (p) => pda([s("__event_authority")], p),
  platformVault: (p, platform, mintB) => pda([platform.toBuffer(), mintB.toBuffer()], p),
  creatorVault: (p, creator, mintB) => pda([creator.toBuffer(), mintB.toBuffer()], p),
  ata: (owner, mint, tokenProgram) =>
    pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID),
};

const u64 = (n) => {
  const v = BigInt(n);
  if (v < 0n || v > 0xffffffffffffffffn) throw new Error("u64 out of range: " + v);
  const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b;
};

// ---------- instructions ----------
/** Byte-identical to sdk buyExactInInstruction(...) without shareFeeReceiver. */
export function buyExactInIx({
  programId = LAUNCHLAB_PROGRAM, owner, auth, configId, platformId, poolId, userTokenAccountA, userTokenAccountB,
  vaultA, vaultB, mintA, mintB, tokenProgramA, tokenProgramB, platformClaimFeeVault,
  creatorClaimFeeVault, amountB, minAmountA, shareFeeRate = 0n,
}) {
  const keys = [
    { pubkey: owner, isSigner: true, isWritable: true },
    { pubkey: auth, isSigner: false, isWritable: false },
    { pubkey: configId, isSigner: false, isWritable: false },
    { pubkey: platformId, isSigner: false, isWritable: false },
    { pubkey: poolId, isSigner: false, isWritable: true },
    { pubkey: userTokenAccountA, isSigner: false, isWritable: true },
    { pubkey: userTokenAccountB, isSigner: false, isWritable: true },
    { pubkey: vaultA, isSigner: false, isWritable: true },
    { pubkey: vaultB, isSigner: false, isWritable: true },
    { pubkey: mintA, isSigner: false, isWritable: false },
    { pubkey: mintB, isSigner: false, isWritable: false },
    { pubkey: tokenProgramA, isSigner: false, isWritable: false },
    { pubkey: tokenProgramB, isSigner: false, isWritable: false },
    { pubkey: pdas.cpiEvent(programId), isSigner: false, isWritable: false },
    { pubkey: programId, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: platformClaimFeeVault, isSigner: false, isWritable: true },
    { pubkey: creatorClaimFeeVault, isSigner: false, isWritable: true },
  ];
  const data = Buffer.concat([Buffer.from(DISC_BUY_EXACT_IN), u64(amountB), u64(minAmountA), u64(shareFeeRate)]);
  return new TransactionInstruction({ keys, programId, data });
}

export function createAtaIdempotentIx(payer, ata, owner, mint, tokenProgram) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}
export const syncNativeIx = (account) =>
  new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, keys: [{ pubkey: account, isSigner: false, isWritable: true }], data: Buffer.from([17]) });
export const closeAccountIx = (account, dest, owner, tokenProgram = TOKEN_PROGRAM_ID) =>
  new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });

// ---------- account decoding (offsets of the sdk marshmallow layouts) ----------
const rd64 = (b, o) => b.readBigUInt64LE(o);
const rdKey = (b, o) => new PublicKey(b.subarray(o, o + 32));

/** sdk LaunchpadPool */
export function decodePool(d) {
  d = Buffer.from(d);
  return {
    epoch: rd64(d, 8), bump: d[16], status: d[17], mintDecimalsA: d[18], mintDecimalsB: d[19], migrateType: d[20],
    supply: rd64(d, 21), totalSellA: rd64(d, 29), virtualA: rd64(d, 37), virtualB: rd64(d, 45),
    realA: rd64(d, 53), realB: rd64(d, 61), totalFundRaisingB: rd64(d, 69),
    protocolFee: rd64(d, 77), platformFee: rd64(d, 85), migrateFee: rd64(d, 93),
    // vestingSchedule 101..141
    configId: rdKey(d, 141), platformId: rdKey(d, 173), mintA: rdKey(d, 205), mintB: rdKey(d, 237),
    vaultA: rdKey(d, 269), vaultB: rdKey(d, 301), creator: rdKey(d, 333),
    mintProgramFlag: d[365], cpmmCreatorFeeOn: d[366],
  };
}
/** sdk LaunchpadConfig (fields we need) */
export function decodeConfig(d) {
  d = Buffer.from(d);
  return { curveType: d[16], index: d.readUInt16LE(17), migrateFee: rd64(d, 19), tradeFeeRate: rd64(d, 27) };
}
/** sdk PlatformConfig (fields we need) */
export function decodePlatform(d) {
  d = Buffer.from(d);
  return { feeRate: rd64(d, 104), creatorFeeRate: rd64(d, 720) };
}

/** SPL / Token-2022 mint: decimals + TransferFeeConfig extension (type 1) if present. */
export function decodeMint(info) {
  const owner = info.owner;
  if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error("mint not owned by a token program");
  const d = Buffer.from(info.data);
  const decimals = d[44];
  let transferFee;
  if (owner.equals(TOKEN_2022_PROGRAM_ID) && d.length > 166) {
    let o = 166; // 82-byte base mint padded to 165, then 1 byte AccountType, then TLV
    while (o + 4 <= d.length) {
      const type = d.readUInt16LE(o), len = d.readUInt16LE(o + 2);
      if (type === 0 && len === 0) break;
      if (type === 1 && len >= 108) {
        const b = o + 4 + 72; // skip 2 authorities + withheldAmount
        transferFee = {
          olderTransferFee: { epoch: rd64(d, b), maximumFee: rd64(d, b + 8), transferFeeBasisPoints: d.readUInt16LE(b + 16) },
          newerTransferFee: { epoch: rd64(d, b + 18), maximumFee: rd64(d, b + 26), transferFeeBasisPoints: d.readUInt16LE(b + 34) },
        };
        break;
      }
      o += 4 + len;
    }
  }
  return { tokenProgram: owner, decimals, transferFee };
}

// ---------- curve math (BigInt port of the sdk) ----------
const ceilDiv = (amount, num, den) => (amount * num + den - 1n) / den; // sdk common/bignumber ceilDiv
const divCeil = (a, b) => (a + b - 1n) / b; // sdk BNDivCeil
const ceilDivBN = (a, b) => { // sdk common/transfer ceilDivBN
  if (a === 0n) return 0n;
  const q = a / b;
  if (q === 0n) return 1n;
  return a % b > 0n ? q + 1n : q;
};
function nowFee(cfg, slot) {
  const epoch = BigInt(Math.floor(slot / 432000));
  return epoch < cfg.newerTransferFee.epoch ? cfg.olderTransferFee : cfg.newerTransferFee;
}
export function transferFeeFromPre(amount, cfg, slot) {
  if (!cfg) return { amount, fee: undefined };
  const f = nowFee(cfg, slot);
  const fee0 = divCeil(amount * BigInt(f.transferFeeBasisPoints), POINT);
  return { amount, fee: fee0 > f.maximumFee ? f.maximumFee : fee0 };
}
export function transferFeeFromPost(amount, cfg, slot) {
  if (!cfg) return { amount, fee: undefined };
  const f = nowFee(cfg, slot);
  const bps = BigInt(f.transferFeeBasisPoints);
  if (bps === POINT) return { amount: amount + f.maximumFee, fee: f.maximumFee };
  const t0 = divCeil(amount * POINT, POINT - bps);
  const T = t0 - amount > f.maximumFee ? amount + f.maximumFee : t0;
  const fee0 = divCeil(T * bps, POINT);
  return { amount: T, fee: fee0 > f.maximumFee ? f.maximumFee : fee0 };
}
const cpOut = (amountIn, inR, outR) => (amountIn * outR) / (inR + amountIn);
const cpIn = (amountOut, inR, outR) => ceilDivBN(inR * amountOut, outR - amountOut);
function calculatePreFee(post, rate) {
  if (rate === 0n) return post;
  if (rate >= FEE_DENOM) throw new Error("feeRate must be less than the fee rate denominator");
  const den = FEE_DENOM - rate;
  return (post * FEE_DENOM + den - 1n) / den;
}

/** sdk Curve.buyExactIn for curveType 0 (ConstantCurve — what StonkFun uses). */
export function curveBuyExactIn({ pool, amountB, feeRate, transferFeeA, transferFeeB, slot, curveType = 0 }) {
  if (curveType !== 0) throw new Error(`unsupported LaunchLab curveType ${curveType}`);
  if (feeRate > FEE_DENOM) throw new Error("total fee rate gt 1_000_000");
  const inB = transferFeeFromPre(amountB, transferFeeB, slot);
  const vaultInB = amountB - (inB.fee ?? 0n);
  const totalFee = ceilDiv(vaultInB, feeRate, FEE_DENOM);
  const lessFee = vaultInB - totalFee;
  const inR = pool.virtualB + pool.realB, outR = pool.virtualA - pool.realA;
  let amountA = cpOut(lessFee, inR, outR);
  const remaining = pool.totalSellA - pool.realA;
  let realAmountB = amountB;
  if (amountA > remaining) {
    amountA = remaining;
    const need = cpIn(amountA, inR, outR);
    realAmountB = transferFeeFromPost(calculatePreFee(need, feeRate), transferFeeB, slot).amount;
  }
  const outA = transferFeeFromPre(amountA, transferFeeA, slot);
  return { amountA: outA.amount, feeA: outA.fee ?? 0n, amountB: realAmountB };
}

// ---------- pool loading ----------
const cache = new Map(); // config / platform / mint accounts: static enough to cache 60 s per warm lambda
async function cachedAccounts(conn, keys) {
  const now = Date.now();
  const miss = keys.filter((k) => { const c = cache.get(k.toBase58()); return !c || now - c.at > 60_000; });
  if (miss.length) {
    const accs = await conn.getMultipleAccountsInfo(miss, { commitment: "confirmed" });
    miss.forEach((k, i) => cache.set(k.toBase58(), { at: now, info: accs[i] }));
  }
  return keys.map((k) => cache.get(k.toBase58()).info);
}

/** Loads one LaunchLab pool + config + platform + both mints. Returns null when the pool PDA doesn't exist. */
export async function loadPool(conn, mintA, mintB) {
  mintA = new PublicKey(mintA); mintB = new PublicKey(mintB);
  const poolId = pdas.pool(LAUNCHLAB_PROGRAM, mintA, mintB);
  const [poolAcc, slot] = await Promise.all([
    conn.getAccountInfo(poolId, { commitment: "processed" }),
    conn.getSlot("processed"),
  ]);
  if (!poolAcc) return null;
  if (!poolAcc.owner.equals(LAUNCHLAB_PROGRAM)) throw new Error("pool not owned by LaunchLab");
  const pool = decodePool(poolAcc.data);
  if (!pool.mintA.equals(mintA) || !pool.mintB.equals(mintB)) throw new Error("pool mint mismatch");
  const [cfgI, platI, mAI, mBI] = await cachedAccounts(conn, [pool.configId, pool.platformId, mintA, mintB]);
  if (!cfgI || !platI || !mAI || !mBI) throw new Error("LaunchLab config/platform/mint account missing");
  const config = decodeConfig(cfgI.data), platform = decodePlatform(platI.data);
  const A = decodeMint(mAI), B = decodeMint(mBI);
  // mintProgramFlag bitfield: bit0 = mintA, bit1 = mintB (1 = Token-2022)
  const flagProg = (bit) => ((pool.mintProgramFlag >> bit) & 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
  if (!A.tokenProgram.equals(flagProg(0))) throw new Error("base token program != mintProgramFlag bit0");
  if (!B.tokenProgram.equals(flagProg(1))) throw new Error("quote token program != mintProgramFlag bit1");
  return {
    poolId, pool, config, platform, mintA, mintB, slot,
    tokenProgramA: A.tokenProgram, tokenProgramB: B.tokenProgram,
    decimalsA: A.decimals, decimalsB: B.decimals, feeA: A.transferFee, feeB: B.transferFee,
    status: pool.status,
  };
}

export function quoteBuy(ctx, amountB, slippageBps) {
  const feeRate = ctx.config.tradeFeeRate + ctx.platform.feeRate + ctx.platform.creatorFeeRate;
  const q = curveBuyExactIn({
    pool: ctx.pool, amountB: BigInt(amountB), feeRate, transferFeeA: ctx.feeA, transferFeeB: ctx.feeB,
    slot: ctx.slot, curveType: ctx.config.curveType,
  });
  const net = q.amountA - q.feeA;
  const amountIn = q.amountB < BigInt(amountB) ? q.amountB : BigInt(amountB);
  return { amountIn, outGross: q.amountA, outNet: net, minAmountA: (net * BigInt(10000 - slippageBps)) / 10000n };
}

/** buy_exact_in instructions. wrapLamports: SOL quote — fund + sync the WSOL ATA first, close it after. */
export function buildBuyIxs(ctx, owner, amountB, minAmountA, { wrapLamports = 0n, createQuoteAta = true } = {}) {
  const userA = pdas.ata(owner, ctx.mintA, ctx.tokenProgramA);
  const userB = pdas.ata(owner, ctx.mintB, ctx.tokenProgramB);
  const isSol = ctx.mintB.equals(NATIVE_MINT);
  const ixs = [createAtaIdempotentIx(owner, userA, owner, ctx.mintA, ctx.tokenProgramA)];
  if (createQuoteAta) ixs.push(createAtaIdempotentIx(owner, userB, owner, ctx.mintB, ctx.tokenProgramB));
  if (isSol && wrapLamports > 0n) {
    ixs.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: userB, lamports: BigInt(wrapLamports) }));
    ixs.push(syncNativeIx(userB));
  }
  ixs.push(buyExactInIx({
    owner, auth: pdas.auth(LAUNCHLAB_PROGRAM), configId: ctx.pool.configId, platformId: ctx.pool.platformId,
    poolId: ctx.poolId, userTokenAccountA: userA, userTokenAccountB: userB,
    vaultA: ctx.pool.vaultA, vaultB: ctx.pool.vaultB, mintA: ctx.mintA, mintB: ctx.mintB,
    tokenProgramA: ctx.tokenProgramA, tokenProgramB: ctx.tokenProgramB,
    platformClaimFeeVault: pdas.platformVault(LAUNCHLAB_PROGRAM, ctx.pool.platformId, ctx.mintB),
    creatorClaimFeeVault: pdas.creatorVault(LAUNCHLAB_PROGRAM, ctx.pool.creator, ctx.mintB),
    amountB: BigInt(amountB), minAmountA: BigInt(minAmountA), shareFeeRate: 0n,
  }));
  if (isSol && wrapLamports > 0n) ixs.push(closeAccountIx(userB, owner, owner));
  return { ixs, userA, userB };
}

/** Spot price, quote per base (human units). */
export function spotPrice(ctx) {
  const p = ctx.pool;
  return (Number(p.virtualB + p.realB) / Number(p.virtualA - p.realA)) * 10 ** (ctx.decimalsA - ctx.decimalsB);
}
