import { useCallback, useEffect, useRef, useState } from "react";

import { KovaraClient } from "../../../packages/sdk/src/client";
import { useNetwork } from "./useNetwork";
import { useWallet } from "./useWallet";
import { useToast } from "../context/ToastContext";

// ── SDK-backed like/unlike transactions ─────────────────────────────────────

async function contractLikePost(liker: string, postId: number, rpcUrl: string, contractId: string): Promise<void> {
  const client = new KovaraClient({ contractId, rpcUrl });
  const xdrEnv = client.like(liker, postId);

  const kit = (
    globalThis as unknown as {
      __Kovara_WALLET_KIT__?: {
        signAndSubmitTransaction: (opts: { txXdr: string }) => Promise<{ hash?: string; txHash?: string }>;
      };
    }
  ).__Kovara_WALLET_KIT__;

  if (kit && typeof kit.signAndSubmitTransaction === "function") {
    const res = await kit.signAndSubmitTransaction({ txXdr: xdrEnv });
    const txHash = res?.hash ?? res?.txHash;
    if (!txHash) throw new Error("Transaction not confirmed");
  } else {
    throw new Error("Wallet signing not available");
  }
}

async function contractUnlikePost(liker: string, postId: number, rpcUrl: string, contractId: string): Promise<void> {
  const client = new KovaraClient({ contractId, rpcUrl });
  const xdrEnv = client.unlike(liker, postId);

  const kit = (
    globalThis as unknown as {
      __Kovara_WALLET_KIT__?: {
        signAndSubmitTransaction: (opts: { txXdr: string }) => Promise<{ hash?: string; txHash?: string }>;
      };
    }
  ).__Kovara_WALLET_KIT__;

  if (kit && typeof kit.signAndSubmitTransaction === "function") {
    const res = await kit.signAndSubmitTransaction({ txXdr: xdrEnv });
    const txHash = res?.hash ?? res?.txHash;
    if (!txHash) throw new Error("Transaction not confirmed");
  } else {
    throw new Error("Wallet signing not available");
  }
}

export interface UseLikeOptions {
  postId: number | string;
  initialHasLiked?: boolean;
  initialLikeCount: number;
}

export interface UseLikeResult {
  liked: boolean;
  likeCount: number;
  pending: boolean;
  error: string | null;
  like: () => Promise<boolean>;
  unlike: () => Promise<boolean>;
}

export function useLike({
  postId,
  initialHasLiked = false,
  initialLikeCount,
}: UseLikeOptions): UseLikeResult {
  const { address, connected } = useWallet();
  const { rpcUrl, contractId } = useNetwork();
  const { showError } = useToast();
  const [liked, setLiked] = useState(initialHasLiked);
  const [likeCount, setLikeCount] = useState(initialLikeCount);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastPostId = useRef(postId);

  useEffect(() => {
    if (lastPostId.current === postId) {
      return;
    }

    lastPostId.current = postId;
    setLiked(initialHasLiked);
    setLikeCount(initialLikeCount);
    setPending(false);
    setError(null);
  }, [postId, initialHasLiked, initialLikeCount]);

  const like = useCallback(async (): Promise<boolean> => {
    if (liked || pending) {
      return false;
    }

    if (!connected || !address) {
      const message = "Connect your wallet to like posts.";
      setError(message);
      showError(message);
      return false;
    }

    setPending(true);
    setError(null);
    setLiked(true);
    setLikeCount((current) => current + 1);

    try {
      await contractLikePost(address, Number(postId), rpcUrl, contractId);
      return true;
    } catch (err) {
      setLiked(false);
      setLikeCount((current) => Math.max(0, current - 1));
      const message = err instanceof Error ? err.message : "Failed to like post.";
      setError(message);
      showError(message);
      return false;
    } finally {
      setPending(false);
    }
  }, [address, connected, liked, pending, postId, rpcUrl, contractId, showError]);

  const unlike = useCallback(async (): Promise<boolean> => {
    if (!liked || pending) {
      return false;
    }

    if (!connected || !address) {
      const message = "Connect your wallet to unlike posts.";
      setError(message);
      showError(message);
      return false;
    }

    setPending(true);
    setError(null);
    setLiked(false);
    setLikeCount((current) => Math.max(0, current - 1));

    try {
      await contractUnlikePost(address, Number(postId), rpcUrl, contractId);
      return true;
    } catch (err) {
      setLiked(true);
      setLikeCount((current) => current + 1);
      const message = err instanceof Error ? err.message : "Failed to unlike post.";
      setError(message);
      showError(message);
      return false;
    } finally {
      setPending(false);
    }
  }, [address, connected, liked, pending, postId, rpcUrl, contractId, showError]);

  return { liked, likeCount, pending, error, like, unlike };
}