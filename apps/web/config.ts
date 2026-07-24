/**
 * packages/web/src/config.ts
 *
 * Centralised environment-variable configuration for the Kovara web app.
 * All process.env / NEXT_PUBLIC_* reads live here; the rest of the app
 * imports typed constants instead of reaching for process.env directly.
 *
 * Issue #113 – replaces hard-coded TODO values in pools/[id]/page.tsx
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(key: string): string {
    const value = process.env[key];
    if (!value) {
      throw new Error(
        `[config] Missing required environment variable: ${key}\n` +
          `Make sure it is set in your .env.local (development) or deployment environment.`
      );
    }
    return value;
  }
  
  function optionalEnv(key: string, fallback: string): string {
    return process.env[key] ?? fallback;
  }
  
  // ---------------------------------------------------------------------------
  // Stellar / Soroban network
  // ---------------------------------------------------------------------------
  
  /** "testnet" | "mainnet" – controls which Horizon endpoint is used */
  export const STELLAR_NETWORK = optionalEnv(
    "NEXT_PUBLIC_STELLAR_NETWORK",
    "testnet"
  ) as "testnet" | "mainnet";
  
  /** Stellar Horizon RPC base URL */
  export const HORIZON_URL = optionalEnv(
    "NEXT_PUBLIC_HORIZON_URL",
    STELLAR_NETWORK === "mainnet"
      ? "https://horizon.stellar.org"
      : "https://horizon-testnet.stellar.org"
  );
  
  /** Soroban RPC URL for contract calls */
  export const SOROBAN_RPC_URL = optionalEnv(
    "NEXT_PUBLIC_SOROBAN_RPC_URL",
    STELLAR_NETWORK === "mainnet"
      ? "https://soroban-rpc.stellar.org"
      : "https://soroban-testnet.stellar.org"
  );
  
  // ---------------------------------------------------------------------------
  // Kovara smart-contract addresses
  // ---------------------------------------------------------------------------
  
  /**
   * On-chain address of the deployed PriceVault contract.
   * Required – the app cannot function without it.
   */
  export const PRICE_VAULT_CONTRACT_ID = requireEnv(
    "NEXT_PUBLIC_PRICE_VAULT_CONTRACT_ID"
  );
  
  /**
   * On-chain address of the FlowRewards contract.
   * Required for the tip / reward submission flows.
   */
  export const FLOW_REWARDS_CONTRACT_ID = requireEnv(
    "NEXT_PUBLIC_FLOW_REWARDS_CONTRACT_ID"
  );
  
  /**
   * On-chain address of the SentinelPool contract.
   */
  export const SENTINEL_POOL_CONTRACT_ID = requireEnv(
    "NEXT_PUBLIC_SENTINEL_POOL_CONTRACT_ID"
  );
  
  /**
   * On-chain address of the KovaraIndex contract.
   */
  export const KOVARA_INDEX_CONTRACT_ID = requireEnv(
    "NEXT_PUBLIC_KOVARA_INDEX_CONTRACT_ID"
  );
  
  // ---------------------------------------------------------------------------
  // Pools page – previously held inline TODO values
  // ---------------------------------------------------------------------------
  
  /**
   * Default XLM tip amount (in stroops) shown on the pools/[id] page.
   * Overridable per-deployment via NEXT_PUBLIC_DEFAULT_TIP_AMOUNT_STROOPS.
   */
  export const DEFAULT_TIP_AMOUNT_STROOPS = parseInt(
    optionalEnv("NEXT_PUBLIC_DEFAULT_TIP_AMOUNT_STROOPS", "500000"), // 0.05 XLM
    10
  );
  
  /**
   * Maximum number of pool entries rendered on pools/[id] before pagination.
   */
  export const POOL_PAGE_ENTRY_LIMIT = parseInt(
    optionalEnv("NEXT_PUBLIC_POOL_PAGE_ENTRY_LIMIT", "50"),
    10
  );
  
  // ---------------------------------------------------------------------------
  // Kovara public API
  // ---------------------------------------------------------------------------
  
  /** Base URL for the @kovara/api REST service */
  export const API_BASE_URL = optionalEnv(
    "NEXT_PUBLIC_API_BASE_URL",
    "https://api.kovara.io/v1"
  );
  
  /** Base URL for the GraphQL endpoint */
  export const GRAPHQL_URL = optionalEnv(
    "NEXT_PUBLIC_GRAPHQL_URL",
    "https://api.kovara.io/graphql"
  );
  
  // ---------------------------------------------------------------------------
  // Feature flags
  // ---------------------------------------------------------------------------
  
  /** Set to "true" to enable the experimental verifier voting UI */
  export const FEATURE_VERIFY_QUEUE =
    optionalEnv("NEXT_PUBLIC_FEATURE_VERIFY_QUEUE", "false") === "true";

    export const env = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001',
  indexerApiUrl: process.env.NEXT_PUBLIC_INDEXER_API_URL || 'http://localhost:3002',
  isDevelopment: process.env.NODE_ENV === 'development',
};