"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { KovaraClient } from "Kovara-sdk";
import { useWallet } from "../../components/WalletProvider";
import { config } from "../../src/config";

// ── SDK-backed like/unlike transactions ─────────────────────────────────────

async function contractLikePost(liker: string, postId: number): Promise<void> {
  const client = new KovaraClient({
    contractId: config.contractId,
    rpcUrl: config.sorobanRpcUrl,
    networkPassphrase: config.networkPassphrase,
  });
  const xdrEnv = client.like(liker, postId);

  if (!window.freighterApi) {
    throw new Error("Freighter wallet not detected");
  }

  const signed = await window.freighterApi.signAndSubmitTransaction({ txXdr: xdrEnv });
  const txHash = signed?.hash ?? signed?.txHash;
  if (!txHash) {
    throw new Error("Transaction not confirmed");
  }
}

async function contractUnlikePost(liker: string, postId: number): Promise<void> {
  const client = new KovaraClient({
    contractId: config.contractId,
    rpcUrl: config.sorobanRpcUrl,
    networkPassphrase: config.networkPassphrase,
  });
  const xdrEnv = client.unlike(liker, postId);

  if (!window.freighterApi) {
    throw new Error("Freighter wallet not detected");
  }

  const signed = await window.freighterApi.signAndSubmitTransaction({ txXdr: xdrEnv });
  const txHash = signed?.hash ?? signed?.txHash;
  if (!txHash) {
    throw new Error("Transaction not confirmed");
  }
}

// Type declaration for Freighter API
declare global {
  interface Window {
    freighterApi?: {
      signAndSubmitTransaction: (opts: { txXdr: string }) => Promise<{ hash?: string; txHash?: string }>;
      signTransaction?: (opts: { txXdr: string }) => Promise<{ signedTxXdr?: string; signedXdr?: string; signedTx?: string }>;
    };
  }
import { useState, useCallback, useEffect, useRef } from "react";
import { useWallet } from "../components/WalletProvider";
import { classifyError } from "./usePoolContract";
import { getContractClient, signAndSubmit } from "../../lib/contract/client";

async function contractLikePost(liker: string, postId: number): Promise<void> {
  const client = getContractClient();
  const xdr = client.like(liker, postId);
  await signAndSubmit(xdr);
}

export interface UseLikeOptions {
  postId: number;
  /** Whether the connected user has already liked this post, from `has_liked`. */
  initialHasLiked?: boolean;
  /** The post's current like count, used to seed the optimistic counter. */
  initialLikeCount: number;
}

export interface UseLikeResult {
  liked: boolean;
  likeCount: number;
  /** True while a like request is in flight. */
  pending: boolean;
  error: string | null;
  /**
   * Like or unlike the post. Optimistically bumps the count, rolls back on failure,
   * and is a no-op when a request is in flight (idempotent).
   * Resolves to `true` only when the transaction was committed.
   */
  like: () => Promise<boolean>;
  unlike: () => Promise<boolean>;
}

/**
 * Drives the like button on a post with optimistic UI.
 *
 * - Initial state is derived from `has_liked` (`initialHasLiked`).
 * - The count increments immediately on click, before the network round-trip.
 * - On transaction failure the optimistic update is rolled back.
 * - Once liked, the action becomes a no-op so the button can stay disabled.
 */
export function useLike({
  postId,
  initialHasLiked = false,
  initialLikeCount,
}: UseLikeOptions): UseLikeResult {
  const { publicKey } = useWallet();
  const [liked, setLiked] = useState(initialHasLiked);
  const [likeCount, setLikeCount] = useState(initialLikeCount);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed state when the hook is reused for a different post (e.g. a detail
  // page that swaps the post in place rather than remounting).
  const lastPostId = useRef(postId);
  useEffect(() => {
    if (lastPostId.current === postId) return;
    lastPostId.current = postId;
    setLiked(initialHasLiked);
    setLikeCount(initialLikeCount);
    setPending(false);
    setError(null);
  }, [postId, initialHasLiked, initialLikeCount]);

  const like = useCallback(async (): Promise<boolean> => {
    // Idempotent: ignore if already liked or a request is mid-flight.
    if (liked || pending) return false;
    if (!publicKey) {
      setError("Connect your wallet to like posts");
      return false;
    }

    setPending(true);
    setError(null);

    // Optimistic update — reflect the like before the round-trip completes.
    setLiked(true);
    setLikeCount((c) => c + 1);

    try {
      await contractLikePost(publicKey, postId);
      return true;
    } catch (err) {
      // Roll back the optimistic update on transaction failure.
      setLiked(false);
      setLikeCount((c) => c - 1);
      const msg = err instanceof Error ? err.message : "Failed to like post";
      setError(msg);
      return false;
    } finally {
      setPending(false);
    }
  }, [liked, pending, publicKey, postId]);

  const unlike = useCallback(async (): Promise<boolean> => {
    // Idempotent: ignore if not liked or a request is mid-flight.
    if (!liked || pending) return false;
    if (!publicKey) {
      setError("Connect your wallet to unlike posts");
      return false;
    }

    setPending(true);
    setError(null);

    // Optimistic update — reflect the unlike before the round-trip completes.
    setLiked(false);
    setLikeCount((c) => Math.max(0, c - 1));

    try {
      await contractUnlikePost(publicKey, postId);
      return true;
    } catch (err) {
      // Roll back the optimistic update on transaction failure.
      setLiked(true);
      setLikeCount((c) => c + 1);
      const msg = err instanceof Error ? err.message : "Failed to unlike post";
      setError(msg);
      return false;
    } finally {
      setPending(false);
    }
  }, [liked, pending, publicKey, postId]);

  return { liked, likeCount, pending, error, like, unlike };
}

export { contractLikePost, contractUnlikePost };