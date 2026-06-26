"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Contract, rpc, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import { getContractClient } from "../../lib/contract/client";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PoolData {
  pool_id: string;
  token: string;
  balance: bigint;
  admins: string[];
  threshold: number;
}

export interface TokenMeta {
  symbol: string;
  decimals: number;
  name: string;
}

export type FetchState = "idle" | "loading" | "success" | "error";

// ── Stellar public key regex (G + 55 base32 chars) ───────────────────────────
export const STELLAR_KEY_RE = /^G[A-Z2-7]{55}$/;

// ── Formatting helpers ────────────────────────────────────────────────────────

export function truncateAddress(addr: string, head = 6, tail = 4): string {
  if (addr.length <= head + tail) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function formatTokenAmount(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString();
  const divisor = BigInt(10 ** decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
}

export function parseTokenAmount(value: string, decimals: number): bigint {
  const [whole, frac = ""] = value.split(".");
  const fracPadded = frac.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(whole || "0") * BigInt(10 ** decimals) + BigInt(fracPadded || "0");
}

// ── Contract client ───────────────────────────────────────────────────────────

async function contractGetPool(poolId: string): Promise<PoolData | null> {
  const client = getContractClient();
  const pool = await client.getPool(poolId);
  if (!pool) return null;
  return {
    pool_id: pool.pool_id,
    token: pool.token,
    balance: pool.balance,
    admins: pool.admins,
    threshold: pool.threshold,
  };
}

async function contractGetAllPools(): Promise<PoolData[]> {
  const knownIds = ["community", "grants", "devfund"];
  const results = await Promise.all(knownIds.map(contractGetPool));
  return results.filter(Boolean) as PoolData[];
}

async function contractGetTokenMeta(tokenAddress: string): Promise<TokenMeta> {
  const rpcUrl = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL!;
  const server = new rpc.Server(rpcUrl);
  const contract = new Contract(tokenAddress);

  const source = (await import("@stellar/stellar-sdk")).Keypair.random();
  const account = new (await import("@stellar/stellar-sdk")).Account(source.publicKey(), "0");
  const builder = new (await import("@stellar/stellar-sdk")).TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE!,
  });

  const symbolOp = contract.call("symbol");
  const decimalsOp = contract.call("decimals");

  const symbolTx = builder.clone().addOperation(symbolOp).setTimeout(30).build();
  const decimalsTx = builder.clone().addOperation(decimalsOp).setTimeout(30).build();

  const [symbolResult, decimalsResult] = await Promise.all([
    server.simulateTransaction(symbolTx),
    server.simulateTransaction(decimalsTx),
  ]);

  const symbol = rpc.Api.isSimulationSuccess(symbolResult) && symbolResult.result
    ? scValToNative(symbolResult.result.retval) as string
    : "TOKEN";
  const decimals = rpc.Api.isSimulationSuccess(decimalsResult) && decimalsResult.result
    ? Number(scValToNative(decimalsResult.result.retval))
    : 7;

  return { symbol, decimals, name: symbol };
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function useAllPools() {
  const [pools, setPools] = useState<PoolData[]>([]);
  const [state, setState] = useState<FetchState>("idle");
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const data = await contractGetAllPools();
      setPools(data);
      setState("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load pools");
      setState("error");
    }
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { pools, state, error, refresh: fetch };
}

export function usePool(poolId: string | null) {
  const [pool, setPool] = useState<PoolData | null>(null);
  const [state, setState] = useState<FetchState>("idle");
  const [error, setError] = useState<string | null>(null);
  const prevId = useRef<string | null>(null);

  const fetch = useCallback(async (id: string) => {
    setState("loading");
    setError(null);
    try {
      const data = await contractGetPool(id);
      setPool(data);
      setState("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pool not found");
      setState("error");
    }
  }, []);

  useEffect(() => {
    if (!poolId || poolId === prevId.current) return;
    prevId.current = poolId;
    fetch(poolId);
  }, [poolId, fetch]);

  return { pool, state, error, refresh: () => poolId && fetch(poolId) };
}

export function useTokenMeta(tokenAddress: string | null) {
  const [meta, setMeta] = useState<TokenMeta | null>(null);

  useEffect(() => {
    if (!tokenAddress) return;
    contractGetTokenMeta(tokenAddress).then(setMeta).catch(() => {});
  }, [tokenAddress]);

  return meta;
}

export { contractGetPool, contractGetAllPools, contractGetTokenMeta };
