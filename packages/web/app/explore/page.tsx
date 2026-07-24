"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { SearchBar } from "../components/SearchBar";
import EmptyState from "../components/EmptyState";
import { PostCardSkeletonList } from "../components/Skeleton";

interface SearchProfile {
  address: string;
  username: string;
  followerCount: number;
}

interface SearchPool {
  pool_id: string;
  token: string;
  balance: string;
  adminCount: number;
}

const MOCK_PROFILES: SearchProfile[] = [
  { address: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", username: "alice", followerCount: 1234 },
  { address: "GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY", username: "bob", followerCount: 567 },
  { address: "GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ", username: "charlie", followerCount: 89 },
  { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", username: "diana", followerCount: 2345 },
  { address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", username: "elena", followerCount: 678 },
];

const MOCK_POOLS: SearchPool[] = [
  { pool_id: "community", token: "USDC", balance: "5000", adminCount: 5 },
  { pool_id: "grants", token: "USDC", balance: "0", adminCount: 2 },
  { pool_id: "devfund", token: "XLM", balance: "12500", adminCount: 3 },
  { pool_id: "treasury", token: "USDC", balance: "25000", adminCount: 4 },
  { pool_id: "rewards", token: "XLM", balance: "8000", adminCount: 3 },
];

async function searchQuery(query: string): Promise<{ profiles: SearchProfile[]; pools: SearchPool[] }> {
  await new Promise((r) => setTimeout(r, 400));
  const q = query.toLowerCase();
  return {
    profiles: MOCK_PROFILES.filter(
      (p) => p.username.toLowerCase().includes(q) || p.address.toLowerCase().includes(q)
    ),
    pools: MOCK_POOLS.filter(
      (p) => p.pool_id.toLowerCase().includes(q) || p.token.toLowerCase().includes(q)
    ),
  };
}

export default function ExplorePage() {
  const [query, setQuery] = useState("");
  const [profiles, setProfiles] = useState<SearchProfile[]>([]);
  const [pools, setPools] = useState<SearchPool[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = useCallback(async (q: string) => {
    setQuery(q);
    if (!q) {
      setProfiles([]);
      setPools([]);
      setError(null);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const result = await searchQuery(q);
      setProfiles(result.profiles);
      setPools(result.pools);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSearching(false);
    }
  }, []);

  const hasResults = profiles.length > 0 || pools.length > 0;
  const showInitial = !query && !searching;
  const showNoResults = query && !searching && !error && !hasResults;

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <h1 style={styles.title}>Explore</h1>
      </header>

      <div style={styles.container}>
        <SearchBar onSearch={handleSearch} />

        {searching && (
          <div style={styles.skeletonWrap}>
            <PostCardSkeletonList count={3} />
          </div>
        )}

        {error && (
          <div style={styles.errorBanner} role="alert">
            <span aria-hidden="true">⚠️</span>
            <span>{error}</span>
            <button onClick={() => handleSearch(query)} style={styles.retryBtn}>
              Retry
            </button>
          </div>
        )}

        {showInitial && (
          <EmptyState
            icon="🔍"
            title="Start exploring"
            description="Search for profiles and pools above."
          />
        )}

        {showNoResults && (
          <EmptyState
            icon="🔍"
            title="No results"
            description={`No profiles or pools matched “${query}”.`}
          />
        )}

        {!searching && !error && hasResults && (
          <>
            {profiles.length > 0 && (
              <section style={styles.section}>
                <h2 style={styles.sectionTitle}>Profiles</h2>
                {profiles.map((profile) => (
                  <Link
                    key={profile.address}
                    href={`/profile/${profile.address}`}
                    style={styles.resultLink}
                  >
                    <div style={styles.resultCard}>
                      <div style={styles.avatar} />
                      <div style={styles.resultInfo}>
                        <div style={styles.resultName}>{profile.username}</div>
                        <div style={styles.resultMeta}>{profile.followerCount} followers</div>
                      </div>
                      <span style={styles.chevron}>→</span>
                    </div>
                  </Link>
                ))}
              </section>
            )}

            {pools.length > 0 && (
              <section style={styles.section}>
                <h2 style={styles.sectionTitle}>Pools</h2>
                {pools.map((pool) => (
                  <Link
                    key={pool.pool_id}
                    href={`/pools/${pool.pool_id}`}
                    style={styles.resultLink}
                  >
                    <div style={styles.resultCard}>
                      <div style={styles.poolIcon}>🏦</div>
                      <div style={styles.resultInfo}>
                        <div style={styles.resultName}>{pool.pool_id}</div>
                        <div style={styles.resultMeta}>
                          {pool.balance} {pool.token} &middot; {pool.adminCount} admins
                        </div>
                      </div>
                      <span style={styles.chevron}>→</span>
                    </div>
                  </Link>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: "100vh",
    background: "var(--color-bg-secondary)",
  },
  header: {
    background: "var(--color-bg)",
    borderBottom: "1px solid var(--color-border)",
    padding: "var(--spacing-lg)",
    position: "sticky",
    top: 0,
    zIndex: 10,
  },
  title: {
    textAlign: "center",
    fontSize: "1.5rem",
    fontWeight: 700,
  },
  container: {
    maxWidth: "600px",
    margin: "0 auto",
    padding: "var(--spacing-lg)",
  },
  skeletonWrap: {
    marginTop: "var(--spacing-md)",
  },
  errorBanner: {
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing-md)",
    padding: "var(--spacing-md)",
    marginTop: "var(--spacing-lg)",
    background: "var(--color-error-light, #fef2f2)",
    border: "1px solid #fca5a5",
    borderRadius: "12px",
    color: "#991b1b",
    fontSize: "0.9rem",
  },
  retryBtn: {
    marginLeft: "auto",
    padding: "var(--spacing-xs) var(--spacing-md)",
    border: "1px solid currentColor",
    borderRadius: "8px",
    background: "none",
    color: "inherit",
    fontWeight: 600,
    cursor: "pointer",
  },
  section: {
    marginTop: "var(--spacing-xl)",
  },
  sectionTitle: {
    fontSize: "1.25rem",
    fontWeight: 700,
    marginBottom: "var(--spacing-md)",
  },
  resultLink: {
    textDecoration: "none",
    color: "inherit",
    display: "block",
    marginBottom: "var(--spacing-sm)",
  },
  resultCard: {
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing-md)",
    padding: "var(--spacing-md)",
    background: "var(--color-bg)",
    border: "1px solid var(--color-border)",
    borderRadius: "12px",
    transition: "border-color 0.2s, box-shadow 0.2s",
  },
  avatar: {
    width: "48px",
    height: "48px",
    borderRadius: "50%",
    background: "var(--color-bg-secondary)",
    flexShrink: 0,
  },
  poolIcon: {
    width: "48px",
    height: "48px",
    borderRadius: "50%",
    background: "var(--color-bg-secondary)",
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "1.5rem",
  },
  resultInfo: {
    flex: 1,
    minWidth: 0,
  },
  resultName: {
    fontWeight: 600,
    fontSize: "0.95rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  resultMeta: {
    fontSize: "0.85rem",
    color: "var(--color-text-secondary)",
    marginTop: "2px",
  },
  chevron: {
    color: "var(--color-text-secondary)",
    fontSize: "1.1rem",
    flexShrink: 0,
  },
};
