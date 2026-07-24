import { useCallback, useState } from "react";

import { useNetwork } from "./useNetwork";
import { useWallet } from "./useWallet";
import { createPost as createPostOnChain } from "../utils/createPost";
import { resolvePostSubmitError } from "../utils/contractErrors";

export interface SubmitPostInput {
  content: string;
}

export interface SubmitPostSuccess {
  ok: true;
  /** Transaction hash returned by the wallet / Soroban RPC. */
  txHash: string;
  /** Post id reported by the contract (best-effort, may equal `txHash` if not yet indexed). */
  postId: string;
}

export interface SubmitPostFailure {
  ok: false;
  /** Friendly, user-facing description of why the submission failed. */
  message: string;
  /** Stable category code for branching on the failure mode in the UI. */
  code:
    | "WALLET_DISCONNECTED"
    | "USER_REJECTED"
    | "CONTENT_INVALID"
    | "UNAUTHORIZED"
    | "NETWORK"
    | "INTERNAL";
  /** Underlying error (kept for logging / Send-to-support flows). */
  cause: unknown;
}

export type SubmitPostResult = SubmitPostSuccess | SubmitPostFailure;

const MAX_CONTENT_LEN = 280;

function validateContent(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return "Post content cannot be empty.";
  }
  if (trimmed.length > MAX_CONTENT_LEN) {
    return `Post is too long (${trimmed.length}/${MAX_CONTENT_LEN} characters).`;
  }
  return null;
}

export interface UseCreatePostReturn {
  submitting: boolean;
  error: string | null;
  /** Reset the local error state, e.g. when the user edits the composer. */
  clearError: () => void;
  submit: (input: SubmitPostInput) => Promise<SubmitPostResult>;
}

/**
 * Hook that exposes a typed `submit` helper for publishing new posts.
 *
 * This is the bridge between the post composer screen and the on-chain
 * `create_post` transaction. It:
 *   1. Pulls `contractId` and `rpcUrl` from the active network context.
 *   2. Pulls the connected wallet address from the wallet context.
 *   3. Delegates the actual transaction to `utils/createPost.ts`.
 *   4. Maps every thrown error into a friendly message + stable code.
 *
 * The hook itself never throws — callers always receive a discriminated
 * `SubmitPostResult` so they can branch on `ok` without try/catch.
 */
export function useCreatePost(): UseCreatePostReturn {
  const { contractId, rpcUrl } = useNetwork();
  const { address, connected, wallet } = useWallet();

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const submit = useCallback(
    async ({ content }: SubmitPostInput): Promise<SubmitPostResult> => {
      setError(null);

      const trimmed = content.trim();
      const validation = validateContent(trimmed);
      if (validation) {
        setError(validation);
        return { ok: false, message: validation, code: "CONTENT_INVALID", cause: null };
      }

      if (!connected || !address) {
        const message = "Connect your wallet to publish this post.";
        setError(message);
        return { ok: false, message, code: "WALLET_DISCONNECTED", cause: null };
      }

      // Some wallets outlive the `connected` flag momentarily after the user
      // has revoked; guard here so we surface a clean error instead of a
      // contract-side auth failure.
      if (!wallet) {
        const message = "Your wallet session has expired. Reconnect and try again.";
        setError(message);
        return { ok: false, message, code: "WALLET_DISCONNECTED", cause: null };
      }

      setSubmitting(true);
      try {
        const txHash = await createPostOnChain({
          contractId,
          rpcUrl,
          author: address,
          content: trimmed,
        });

        const postId = txHash ? txHash.slice(0, 16) : String(Date.now());
        return { ok: true, txHash, postId };
      } catch (cause) {
        const resolved = resolvePostSubmitError(cause);
        setError(resolved.message);
        return { ok: false, message: resolved.message, code: resolved.code, cause };
      } finally {
        setSubmitting(false);
      }
    },
    [address, connected, contractId, rpcUrl, wallet]
  );

  return { submitting, error, clearError, submit };
}
