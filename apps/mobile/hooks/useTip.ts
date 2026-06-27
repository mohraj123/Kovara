import { useCallback, useMemo, useState } from "react";

import { useToast } from "../context/ToastContext";
import { useNetwork } from "./useNetwork";
import { useWallet } from "./useWallet";
import { sdkTip } from "../utils/sdkTip";

export type TipStatus = "idle" | "pending" | "success" | "error";

export interface TipToken {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
}

export interface TipResult {
  hash: string;
  amount: number;
  token: TipToken;
  protocolFee: number;
}

interface SubmitTipOptions {
  postId: number | string;
  amount: number;
  token: TipToken;
}

export interface UseTipResult {
  status: TipStatus;
  pending: boolean;
  error: string | null;
  result: TipResult | null;
  estimateProtocolFee: (amount: number) => number;
  tip: (options: SubmitTipOptions) => Promise<boolean>;
  reset: () => void;
}

const PROTOCOL_FEE_BPS = 100;

// Global wallet kit reference (set by WalletContext)
declare global {
  // eslint-disable-next-line no-var, @typescript-eslint/no-explicit-any
  var __Kovara_WALLET_KIT__: any;
}

export function useTip(): UseTipResult {
  const { address, connected } = useWallet();
  const { contractId, rpcUrl } = useNetwork();
  const { showPending, showSuccess, showError } = useToast();
  const [status, setStatus] = useState<TipStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TipResult | null>(null);

  const estimateProtocolFee = useCallback((amount: number) => {
    if (!Number.isFinite(amount) || amount <= 0) {
      return 0;
    }

    return amount * (PROTOCOL_FEE_BPS / 10_000);
  }, []);

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    setResult(null);
  }, []);

  const tip = useCallback(
    async ({ postId, amount, token }: SubmitTipOptions): Promise<boolean> => {
      if (status === "pending") {
        return false;
      }

      if (!connected || !address) {
        const message = "Connect your wallet to tip this post.";
        setStatus("error");
        setError(message);
        showError(message);
        return false;
      }

      if (!Number.isFinite(amount) || amount <= 0) {
        const message = "Enter a positive, non-zero tip amount.";
        setStatus("error");
        setError(message);
        showError(message);
        return false;
      }

      const walletKit = globalThis.__Kovara_WALLET_KIT__;
      if (!walletKit) {
        const message = "Wallet not initialized. Please reconnect.";
        setStatus("error");
        setError(message);
        showError(message);
        return false;
      }

      setStatus("pending");
      setError(null);
      setResult(null);
      showPending();

      try {
        // Convert amount to bigint with proper decimal precision
        // Amount is in token units (e.g., 1.5 XLM), need to convert to stroops
        const amountBigInt = BigInt(Math.floor(amount * Math.pow(10, token.decimals)));
        const numericPostId = typeof postId === "string" ? parseInt(postId, 10) : postId;

        const { txHash } = await sdkTip(
          contractId,
          rpcUrl,
          address,
          numericPostId,
          amountBigInt,
          walletKit
        );

        const protocolFee = estimateProtocolFee(amount);
        setResult({ hash: txHash, amount, token, protocolFee });
        setStatus("success");
        showSuccess(txHash);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to submit tip.";
        setStatus("error");
        setError(message);
        showError(message);
        return false;
      }
    },
    [
      address,
      connected,
      contractId,
      rpcUrl,
      estimateProtocolFee,
      showError,
      showPending,
      showSuccess,
      status,
    ]
  );

  const pending = status === "pending";

  return useMemo(
    () => ({
      status,
      pending,
      error,
      result,
      estimateProtocolFee,
      tip,
      reset,
    }),
    [error, estimateProtocolFee, pending, reset, result, status, tip]
  );
}

export { PROTOCOL_FEE_BPS };
