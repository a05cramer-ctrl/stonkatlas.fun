import { Connection } from "@solana/web3.js";

export function rpcUrl() {
  if (process.env.HELIUS_API_KEY) return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  if (process.env.RPC_URL) return process.env.RPC_URL;
  return "https://api.mainnet-beta.solana.com"; // public fallback: rate-limited, fine for testing only
}

let conn;
export function connection() {
  if (!conn) conn = new Connection(rpcUrl(), { commitment: "confirmed", disableRetryOnRateLimit: false });
  return conn;
}
