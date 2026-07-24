"use client";

import Link from "next/link";
import { RequireWallet } from "@/components/RequireWallet";
import { PostComposer } from "@/components/PostComposer";

export default function NewPostPage() {
  return (
    <main className="container mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">New Post</h1>
        <Link
          href="/"
          className="text-sm text-[var(--text-muted)] hover:text-[var(--foreground)]"
          aria-label="Cancel and return to home"
        >
          ← Cancel
        </Link>
      </header>

      {/*
        Closes #122. Route-level protection: the post composer and `Publish`
        button only render when a Stellar wallet is connected. Disconnected
        users see a focused Connect Wallet CTA and cannot reach the composer.
      */}
      <RequireWallet action="to publish a post">
        <PostComposer />
      </RequireWallet>
    </main>
  );
}
