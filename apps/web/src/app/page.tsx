import Link from "next/link";

export default function Home() {
  return (
    <main className="container mx-auto max-w-2xl px-4 py-12">
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--muted)]/40 p-10">
        <h1 className="text-3xl font-extrabold tracking-tight">Welcome to Kōvara</h1>
        <p className="mt-3 text-[var(--text-muted)]">
          A decentralised, on-chain social layer on Stellar. Connect a Stellar wallet to publish
          posts, follow other users, and join the community cost-of-living oracle.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/post/new"
            className="rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-500"
            aria-label="Create a new post (requires a connected wallet)"
          >
            Create a Post →
          </Link>
          <Link
            href="/explore"
            className="rounded-lg border border-[var(--border)] px-5 py-2.5 text-sm font-semibold transition-colors hover:border-violet-500/60 hover:text-violet-300"
          >
            Explore
          </Link>
        </div>
      </section>

      <section className="mt-10 grid gap-4 sm:grid-cols-2">
        <FeatureCard
          title="On-chain posts"
          body="Every post is a signed Soroban transaction. Freighter signs locally — your keys never leave the extension."
        />
        <FeatureCard
          title="Cost-of-living oracle"
          body="Submit local prices for bread, rent, transport, and utilities. Peers cross-verify on-chain."
        />
        <FeatureCard
          title="Micro-rewards"
          body="Verified contributions earn XLM and Stellar USDC micro-rewards, paid out from the community treasury."
        />
        <FeatureCard
          title="Open data"
          body="Every index entry is published immutably. Fork the contracts, audit the methodology, redeploy."
        />
      </section>
    </main>
  );
}

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <article className="rounded-xl border border-[var(--border)] bg-[var(--muted)]/30 p-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1.5 text-sm text-[var(--text-muted)]">{body}</p>
    </article>
  );
}
