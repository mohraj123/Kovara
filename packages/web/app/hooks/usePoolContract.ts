"use client";

import { useState, useCallback } from "react";
import { parseTokenAmount } from "./usePools";
import { getContractClient, signAndSubmit } from "../../lib/contract/client";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TxStatus =
  | "idle"
  | "approving"       // increase_allowance step
  | "awaiting_sig"    // waiting for Freighter signature
  | "submitting"      // tx broadcast
  | "success"
  | "error";

export interface TxResult {
  hash: string;
  ledger: number;
}

// ── Error classifier ──────────────────────────────────────────────────────────

export function classifyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/allowance|insufficient allowance/i.test(msg)) return "Insufficient Allowance";
  if (/balance|low balance/i.test(msg)) return "Insufficient Balance";
  if (/unauthorized|not admin/i.test(msg)) return "Unauthorized — you are not a pool admin";
  if (/pool not found/i.test(msg)) return "Pool not found";
  if (/wrong token/i.test(msg)) return "Token mismatch — wrong token for this pool";
  if (/threshold|insufficient signers/i.test(msg))
    return "Not enough admin signatures to execute withdrawal";
  if (/user rejected|denied/i.test(msg)) return "Transaction rejected by wallet";
  return msg || "Transaction failed";
}

// ── Contract calls ────────────────────────────────────────────────────────────

async function callIncreaseAllowance(
  depositor: string,
  token: string,
  amount: bigint,
  spender: string
): Promise<void> {
  const { Contract, TransactionBuilder, Account, Keypair, nativeToScVal } = await import("@stellar/stellar-sdk");
  const rpcUrl = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL!;
  const passphrase = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE!;

  const server = new rpc.Server(rpcUrl);
  const contract = new Contract(token);
  const source = Keypair.random();
  const account = new Account(source.publicKey(), "0");

  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: passphrase })
    .addOperation(contract.call("increase_allowance",
      nativeToScVal(depositor, { type: "address" }),
      nativeToScVal(spender, { type: "address" }),
      nativeToScVal(amount, { type: "i128" })
    ))
    .setTimeout(30)
    .build();

  const simulated = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulated)) {
    throw new Error(simulated.error);
  }

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(source);
  const sendResult = await server.sendTransaction(prepared);
  if (sendResult.status === "ERROR") {
    throw new Error(sendResult.errorResult?.result().toString() ?? "Allowance failed");
  }

  let getResult = await server.getTransaction(sendResult.hash);
  while (getResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    await new Promise((r) => setTimeout(r, 1000));
    getResult = await server.getTransaction(sendResult.hash);
  }
  if (getResult.status === rpc.Api.GetTransactionStatus.FAILED) {
    throw new Error("Allowance transaction failed on-chain");
  }
}

async function callPoolDeposit(
  depositor: string,
  poolId: string,
  _token: string,
  amount: bigint
): Promise<TxResult> {
  const client = getContractClient();
  const xdr = client.deposit(depositor, poolId, _token, amount);
  return signAndSubmit(xdr);
}

async function callPoolWithdraw(
  signers: string[],
  poolId: string,
  amount: bigint,
  recipient: string
): Promise<TxResult> {
  const client = getContractClient();
  const xdr = client.withdraw(signers, poolId, amount, recipient);
  return signAndSubmit(xdr);
}

async function callCreatePool(
  admin: string,
  poolId: string,
  token: string,
  initialAdmins: string[],
  threshold: number
): Promise<TxResult> {
  const client = getContractClient();
  const xdr = client.createPool(admin, token, initialAdmins, threshold);
  return signAndSubmit(xdr);
}

// ── useDeposit ────────────────────────────────────────────────────────────────

export function useDeposit() {
  const [status, setStatus] = useState<TxStatus>("idle");
  const [result, setResult] = useState<TxResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const deposit = useCallback(
    async (
      depositor: string,
      poolId: string,
      token: string,
      amountRaw: string,
      decimals: number,
      contractAddress: string
    ) => {
      setStatus("approving");
      setError(null);
      setResult(null);

      try {
        const amount = parseTokenAmount(amountRaw, decimals);

        // Step 1: increase_allowance for the SEP-41 token
        await callIncreaseAllowance(depositor, token, amount, contractAddress);

        // Step 2: pool_deposit
        setStatus("awaiting_sig");
        await new Promise((r) => setTimeout(r, 300)); // brief pause for UX
        setStatus("submitting");

        const tx = await callPoolDeposit(depositor, poolId, token, amount);
        setResult(tx);
        setStatus("success");
      } catch (err) {
        setError(classifyError(err));
        setStatus("error");
      }
    },
    []
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setResult(null);
    setError(null);
  }, []);

  return { status, result, error, deposit, reset };
}

// ── useWithdraw ───────────────────────────────────────────────────────────────

export function useWithdraw() {
  const [status, setStatus] = useState<TxStatus>("idle");
  const [result, setResult] = useState<TxResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const withdraw = useCallback(
    async (
      signers: string[],
      poolId: string,
      amountRaw: string,
      decimals: number,
      recipient: string
    ) => {
      setStatus("awaiting_sig");
      setError(null);
      setResult(null);

      try {
        const amount = parseTokenAmount(amountRaw, decimals);

        setStatus("submitting");
        const tx = await callPoolWithdraw(signers, poolId, amount, recipient);
        setResult(tx);
        setStatus("success");
      } catch (err) {
        setError(classifyError(err));
        setStatus("error");
      }
    },
    []
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setResult(null);
    setError(null);
  }, []);

  return { status, result, error, withdraw, reset };
}

// ── useCreatePool ─────────────────────────────────────────────────────────────

export function useCreatePool() {
  const [status, setStatus] = useState<TxStatus>("idle");
  const [result, setResult] = useState<TxResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createPool = useCallback(
    async (
      admin: string,
      poolId: string,
      token: string,
      initialAdmins: string[],
      threshold: number
    ) => {
      setStatus("awaiting_sig");
      setError(null);
      setResult(null);

      try {
        setStatus("submitting");
        const tx = await callCreatePool(admin, poolId, token, initialAdmins, threshold);
        setResult(tx);
        setStatus("success");
      } catch (err) {
        setError(classifyError(err));
        setStatus("error");
      }
    },
    []
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setResult(null);
    setError(null);
  }, []);

  return { status, result, error, createPool, reset };
}
