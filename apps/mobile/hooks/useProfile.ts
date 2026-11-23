import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KovaraClient } from "../../../packages/sdk/src/client";
import { IndexerError } from "../../../packages/sdk/src/errors";

import { useNetwork } from "./useNetwork";
import { useFollowers } from "./useFollowers";
import { useFollowing } from "./useFollowing";
import { useWallet } from "./useWallet";
import { useToast } from "../context/ToastContext";
import { submitProfileTransaction } from "./profileContract";
import type { IndexerErrorCode } from "../components/states/ErrorState";

export interface Profile {
  address: string;
  username?: string | null;
  bio?: string | null;
  bannerUrl?: string | null;
}

interface ProfileState {
  address: string;
  profile: Profile | null;
  loading: boolean;
  error: string | null;
  errorCode: IndexerErrorCode | undefined;
}

export function useProfile(address: string) {
  const { rpcUrl, contractId } = useNetwork();
  const { address: me } = useWallet();

  const clientRef = useRef<KovaraClient | null>(null);
  clientRef.current = clientRef.current ?? new KovaraClient({ contractId, rpcUrl });

  // Every result is tagged with the address it was fetched for so a response
  // that resolves after the route address changed can never be shown for the
  // new address.
  const [state, setState] = useState<ProfileState>(() => ({
    address,
    profile: null,
    loading: !!address,
    error: null,
    errorCode: undefined,
  }));
  const latestRequestRef = useRef(0);

  const followers = useFollowers(address ?? "");
  const following = useFollowing(address ?? "");

  const myFollowing = useFollowing(me ?? "");

  const followerCount = followers.users.length;
  const followingCount = following.users.length;

  const isFollowing = useMemo(() => {
    if (!me) return false;
    return myFollowing.users.some((u) => u.address === address);
  }, [me, myFollowing.users, address]);

  const fetchProfile = useCallback(async () => {
    const requestId = ++latestRequestRef.current;
    if (!address) {
      setState({ address, profile: null, loading: false, error: null, errorCode: undefined });
      return;
    }
    setState((prev) => ({
      address,
      // Keep the current profile while refreshing the same address, but never
      // carry one over from a different address.
      profile: prev.address === address ? prev.profile : null,
      loading: true,
      error: null,
      errorCode: undefined,
    }));
    const isStale = () => requestId !== latestRequestRef.current;
    try {
      const client = clientRef.current as KovaraClient;
      const p = await client.getProfile(address);
      if (isStale()) return;
      setState({
        address,
        profile: p
          ? {
              address,
              username: p.username ?? null,
              bio: (p.bio as string) ?? null,
              bannerUrl:
                (p.bannerUrl as string | undefined) ??
                (p.banner_url as string | undefined) ??
                (p.banner as string | undefined) ??
                (p.coverUrl as string | undefined) ??
                (p.cover_image as string | undefined) ??
                null,
            }
          : null,
        loading: false,
        error: null,
        errorCode: undefined,
      });
    } catch (e) {
      if (isStale()) return;
      // eslint-disable-next-line no-console
      console.warn("Failed to load profile", e);
      setState({
        address,
        profile: null,
        loading: false,
        error: e instanceof IndexerError ? e.message : "Failed to load profile.",
        errorCode: e instanceof IndexerError ? (e.statusCode as IndexerErrorCode) : undefined,
      });
    }
  }, [address]);

  useEffect(() => {
    fetchProfile();
    return () => {
      // Invalidate any in-flight request when the address changes or the
      // screen unmounts.
      latestRequestRef.current++;
    };
  }, [fetchProfile]);

  // Between an address change and the effect above firing, `state` still
  // describes the previous address; report that render as loading.
  const isCurrent = state.address === address;
  const profile = isCurrent ? state.profile : null;
  const loading = isCurrent ? state.loading : !!address;
  const error = isCurrent ? state.error : null;
  const errorCode = isCurrent ? state.errorCode : undefined;

  const { showPending, showSuccess, showError } = useToast();

  const toggleFollow = useCallback(async () => {
    if (!address) return;
    if (!me) {
      showError("Connect your wallet to follow users.");
      return;
    }

    const client = clientRef.current as KovaraClient;
    if (!client) {
      showError("SDK client not available");
      return;
    }

    const txXdr = isFollowing ? client.unfollow(me, address) : client.follow(me, address);

    showPending();

    try {
      // Try to use an injected wallet kit that can sign/submit
      const kit = (
        globalThis as unknown as {
          __Kovara_WALLET_KIT__?: {
            signAndSubmitTransaction: (opts: {
              txXdr: string;
            }) => Promise<{ hash?: string; txHash?: string }>;
          };
        }
      ).__Kovara_WALLET_KIT__;

      if (kit && typeof kit.signAndSubmitTransaction === "function") {
        const res = await kit.signAndSubmitTransaction({ txXdr });
        const txHash = res?.hash ?? res?.txHash ?? "";
        showSuccess(txHash);
      } else if (kit && typeof kit.signTransaction === "function") {
        const signed = await kit.signTransaction({ txXdr });
        const signedXdr = signed?.signedTxXdr ?? signed?.signedXdr ?? signed?.signedTx;
        if (!signedXdr) throw new Error("Wallet did not return signed transaction XDR");

        const { rpc } = await import("@stellar/stellar-sdk");
        const server = new rpc.Server(rpcUrl);
        const submitRes = await server.submitTransaction(signedXdr);
        const txHash = submitRes?.hash ?? "";
        showSuccess(txHash);
      } else {
        throw new Error("Wallet signing not available in this environment");
      }

      // refresh followers/following after success
      followers.refresh();
      following.refresh();
      myFollowing.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to submit transaction";
      showError(msg);
    }
  }, [
    address,
    me,
    isFollowing,
    rpcUrl,
    showError,
    showPending,
    showSuccess,
    followers,
    following,
    myFollowing,
  ]);

  const refresh = useCallback(() => {
    fetchProfile();
    // trigger followers/following refresh by calling their refresh methods if available
    followers.refresh();
    following.refresh();
    myFollowing.refresh();
  }, [fetchProfile, followers, following, myFollowing]);

  return {
    profile,
    loading,
    error,
    errorCode,
    followerCount,
    followingCount,
    isFollowing,
    toggleFollow,
    refresh,
  } as const;
}

export interface ProfileUpdateInput {
  username: string;
  creatorToken: string;
  bannerUrl: string;
}

export type ProfileSaveErrorField = "username" | "creatorToken";

export interface ProfileSaveError {
  /** Friendly summary safe to show as a heading. */
  message: string;
  /** Raw failure reported by the wallet / network, kept for the user to inspect. */
  detail: string | null;
  /** Form field the failure is attributable to, when known. */
  field?: ProfileSaveErrorField;
}

// Contract error codes from `ContractError` in linkora-contracts/src/lib.rs
// that `set_profile` can raise.
const PROFILE_CONTRACT_ERRORS: Record<number, Omit<ProfileSaveError, "detail">> = {
  3: { message: "The network rejected this username.", field: "username" },
  4: { message: "The creator token address is not a valid token.", field: "creatorToken" },
  5: { message: "That username is already taken.", field: "username" },
  37: { message: "Username is too short.", field: "username" },
  38: { message: "Username is too long.", field: "username" },
  39: { message: "Username contains characters that aren't allowed.", field: "username" },
  40: { message: "The creator token can't be the Kovara contract itself.", field: "creatorToken" },
};

const CONTRACT_ERROR_RE = /Error\(Contract,\s*#(\d+)\)/i;

/**
 * Turns whatever the profile transaction pipeline threw into a message the
 * edit screen can keep on screen, without discarding the underlying failure.
 */
export function resolveProfileSaveError(err: unknown): ProfileSaveError {
  const detail =
    err instanceof Error ? err.message || null : typeof err === "string" ? err || null : null;
  const lower = (detail ?? "").toLowerCase();

  const contractMatch = detail?.match(CONTRACT_ERROR_RE);
  if (contractMatch) {
    const known = PROFILE_CONTRACT_ERRORS[Number(contractMatch[1])];
    if (known) return { ...known, detail };
  }

  if (/user (rejected|declined|cancell?ed)|rejected by user|denied by the user/.test(lower)) {
    return { message: "You canceled the transaction.", detail };
  }
  if (/network|timeout|timed out|failed to fetch|fetch failed|econn/.test(lower)) {
    return { message: "Network error. Check your connection and try again.", detail };
  }
  if (lower.includes("not confirmed")) {
    return { message: "The transaction was submitted but not confirmed.", detail };
  }
  if (lower.includes("signing not available") || lower.includes("did not return signed")) {
    return { message: "Your wallet couldn't sign this transaction.", detail };
  }

  return { message: "Failed to update profile.", detail };
}

/**
 * Submits a profile update. Failures are kept in `saveError` (rather than only
 * flashed in a toast) so the edit form can show them next to the user's
 * unsaved edits until they retry or change the offending field.
 */
export function useUpdateProfile() {
  const { rpcUrl, contractId } = useNetwork();
  const { address, connected } = useWallet();
  const { showPending, showSuccess, showError } = useToast();

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ProfileSaveError | null>(null);

  const clearSaveError = useCallback(() => setSaveError(null), []);

  const saveProfile = useCallback(
    async (input: ProfileUpdateInput): Promise<string | null> => {
      if (!connected || !address) {
        const error = { message: "Connect your wallet to edit your profile.", detail: null };
        setSaveError(error);
        showError(error.message);
        return null;
      }

      setSaving(true);
      setSaveError(null);
      showPending();
      try {
        const txHash = await submitProfileTransaction(
          address,
          input.username.trim(),
          input.creatorToken.trim(),
          input.bannerUrl.trim(),
          rpcUrl,
          contractId
        );
        showSuccess(txHash);
        return txHash;
      } catch (err) {
        const error = resolveProfileSaveError(err);
        setSaveError(error);
        showError(error.message, "Profile not saved");
        return null;
      } finally {
        setSaving(false);
      }
    },
    [address, connected, contractId, rpcUrl, showError, showPending, showSuccess]
  );

  return { saving, saveError, saveProfile, clearSaveError } as const;
}
