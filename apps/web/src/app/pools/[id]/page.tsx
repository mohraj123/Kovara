"use client";

/**
 * packages/web/app/pools/[id]/page.tsx
 *
 * Pool detail page. Previously contained hard-coded TODO placeholders for
 * contract IDs and network config. All env-backed values are now imported
 * from `src/config.ts`.
 *
 * Issue #113 – replace local TODOs with env config import
 */

import { useEffect, useState } from "react";
import { API_BASE_URL, DEFAULT_TIP_AMOUNT_STROOPS, FLOW_REWARDS_CONTRACT_ID, HORIZON_URL, POOL_PAGE_ENTRY_LIMIT, PRICE_VAULT_CONTRACT_ID, STELLAR_NETWORK } from "../../../../config";


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PoolEntry {
  id: string;
  contributor: string;
  category: string;
  amount: number;
  verifiedAt: string | null;
}

interface Pool {
  id: string;
  countryIso: string;
  totalEntries: number;
  entries: PoolEntry[];
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

interface PoolPageProps {
  params: { id: string };
}

export default function PoolPage({ params }: PoolPageProps) {
  const { id } = params;

  const [pool, setPool] = useState<Pool | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchPool() {
      try {
        setLoading(true);
        const res = await fetch(
          `${API_BASE_URL}/pools/${id}?limit=${POOL_PAGE_ENTRY_LIMIT}`
        );
        if (!res.ok) {
          throw new Error(`Failed to load pool: ${res.statusText}`);
        }
        const data: Pool = await res.json();
        setPool(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    }

    fetchPool();
  }, [id]);

  // Debug banner visible only in development
  const isDevMode = process.env.NODE_ENV === "development";

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      {/* Dev config banner – issue #113: contract IDs no longer TODO */}
      {isDevMode && (
        <aside className="mb-6 rounded-md bg-yellow-50 px-4 py-3 text-xs text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-300">
          <p>
            <strong>Dev mode</strong> · Network:{" "}
            <code>{STELLAR_NETWORK}</code> · Horizon:{" "}
            <code>{HORIZON_URL}</code>
          </p>
          <p>
            PriceVault: <code>{PRICE_VAULT_CONTRACT_ID}</code>
          </p>
          <p>
            FlowRewards: <code>{FLOW_REWARDS_CONTRACT_ID}</code>
          </p>
          <p>
            Default tip:{" "}
            <code>{DEFAULT_TIP_AMOUNT_STROOPS / 10_000_000} XLM</code>
          </p>
        </aside>
      )}

      <h1 className="mb-6 text-2xl font-bold">Pool: {id}</h1>

      {loading && (
        <p className="text-muted-foreground animate-pulse">Loading pool…</p>
      )}

      {error && (
        <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}

      {pool && !loading && (
        <>
          <dl className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div className="rounded-lg border p-4">
              <dt className="text-muted-foreground text-xs uppercase tracking-wide">
                Country
              </dt>
              <dd className="mt-1 text-lg font-semibold">{pool.countryIso}</dd>
            </div>
            <div className="rounded-lg border p-4">
              <dt className="text-muted-foreground text-xs uppercase tracking-wide">
                Total entries
              </dt>
              <dd className="mt-1 text-lg font-semibold">
                {pool.totalEntries.toLocaleString()}
              </dd>
            </div>
            <div className="rounded-lg border p-4">
              <dt className="text-muted-foreground text-xs uppercase tracking-wide">
                Showing
              </dt>
              <dd className="mt-1 text-lg font-semibold">
                {pool.entries.length} / {POOL_PAGE_ENTRY_LIMIT}
              </dd>
            </div>
          </dl>

          <section>
            <h2 className="mb-4 text-lg font-semibold">Entries</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-gray-500">
                    <th className="pb-2 pr-4">Contributor</th>
                    <th className="pb-2 pr-4">Category</th>
                    <th className="pb-2 pr-4">Amount</th>
                    <th className="pb-2">Verified</th>
                  </tr>
                </thead>
                <tbody>
                  {pool.entries.map((entry) => (
                    <tr key={entry.id} className="border-b last:border-none">
                      <td className="py-2 pr-4 font-mono text-xs">
                        {entry.contributor.slice(0, 8)}…
                      </td>
                      <td className="py-2 pr-4">{entry.category}</td>
                      <td className="py-2 pr-4">{entry.amount}</td>
                      <td className="py-2">
                        {entry.verifiedAt ? (
                          <span className="text-green-600">✓</span>
                        ) : (
                          <span className="text-gray-400">Pending</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}