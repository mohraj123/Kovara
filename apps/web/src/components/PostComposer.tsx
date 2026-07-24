"use client";

import { useCallback, useState } from "react";
import { validatePostContent, sanitisePostContent, POST_MAX_CHARS } from "@/lib/validate";
import { useWallet } from "@/hooks/useWallet";
import { createPostOnChain } from "@/lib/createPost";

/**
 * Composer for an on-chain post.
 *
 * Defense in depth for #122:
 *   - The `/post/new` route wraps this in `<RequireWallet>` so the route
 *     itself is wallet-gated.
 *   - This component ALSO short-circuits to a focused Connect Wallet
 *     state when `useWallet().connected === false`, mirroring the
 *     pattern in `packages/web/app/components/CreatePost.tsx`.
 *
 * The two layers together mean: anyone who imports `<PostComposer/>`
 * directly — including future routes or refactors — cannot accidentally
 * expose the Publish action to a disconnected user.
 */
export function PostComposer() {
  const { address, connected, connect } = useWallet();
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Wallet-gated short-circuit — see #122.
  // Mirrors the pattern in `packages/web/app/components/CreatePost.tsx`.
  if (!connected) {
    return (
      <div
        role="region"
        aria-live="polite"
        aria-label="Connect your wallet to publish a post"
        className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-2xl border border-[var(--border)] bg-[var(--muted)]/40 p-8 text-center"
      >
        <div aria-hidden="true" className="text-4xl">
          👛
        </div>
        <div>
          <h2 className="text-lg font-semibold">Connect your wallet to publish</h2>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Posts are signed on-chain with Freighter — your keys never leave the extension.
          </p>
        </div>
        <button
          type="button"
          onClick={connect}
          aria-label="Connect Freighter wallet"
          className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-400"
        >
          Connect Wallet
        </button>
      </div>
    );
  }

  const trimmedLength = content.trim().length;
  const overLimit = content.length > POST_MAX_CHARS;
  const empty = trimmedLength === 0;
  const disabled = empty || overLimit || submitting;

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setContent(e.target.value);
      if (error) setError(null);
    },
    [error]
  );

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const sanitised = sanitisePostContent(content);
      const result = validatePostContent(sanitised);
      if (!result.valid) {
        setError(result.error ?? "Invalid post content.");
        return;
      }
      setSubmitting(true);
      try {
        await createPostOnChain(sanitised);
        setContent("");
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to publish.");
      } finally {
        setSubmitting(false);
      }
    },
    [content]
  );

  const remaining = POST_MAX_CHARS - content.length;

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Create post"
      noValidate
      className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--muted)]/40 p-5"
    >
      {address && (
        <p
          className="text-xs font-mono text-[var(--text-muted)]"
          aria-label={`Posting as ${address}`}
        >
          Posting as {address.slice(0, 4)}…{address.slice(-4)}
        </p>
      )}

      <label htmlFor="post-content" className="text-sm font-medium">
        What&apos;s on your mind?
      </label>
      <textarea
        id="post-content"
        name="content"
        value={content}
        onChange={onChange}
        rows={4}
        maxLength={POST_MAX_CHARS + 50}
        disabled={submitting}
        aria-describedby={error ? "post-content-error" : undefined}
        aria-invalid={Boolean(error)}
        placeholder="Share something with the Kovara community…"
        className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:opacity-50"
      />

      {error && (
        <p id="post-content-error" role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-2 text-xs">
        <span
          aria-live="polite"
          aria-label={`${remaining} characters remaining`}
          className={
            overLimit
              ? "font-semibold text-red-500"
              : remaining <= 20
                ? "text-yellow-400"
                : "text-[var(--text-muted)]"
          }
        >
          {remaining}
        </span>
      </div>

      <button
        type="submit"
        disabled={disabled}
        className="self-end rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Publishing…" : "Publish Post"}
      </button>
    </form>
  );
}
