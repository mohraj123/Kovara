# Kōvara — Web App (`apps/web`)

The Kōvara Next.js 15 web application. This is the main contributor-facing
surface for publishing posts, exploring the cost-of-living oracle, and
managing an on-chain profile.

> **Stellar Wave Program:** see [`apps/web/VALIDATION.md`](./VALIDATION.md)
> for the form-validation contract that every form component follows.

---

## Prerequisites

| Tool      | Version                            |
| --------- | ---------------------------------- |
| Node.js   | 20+                                |
| pnpm      | 9+                                 |
| Freighter | latest browser extension (runtime) |

Install the Stellar CLI if you also want to deploy contracts from scratch:

```bash
cargo install --locked stellar-cli
```

---

## Install

From the repository root:

```bash
pnpm install
```

This installs all workspace dependencies (including the SDK contract client
and `@stellar/freighter-api`).

---

## Configure environment variables

The Next.js app reads every contract address, RPC URL, and feature flag via
`process.env.NEXT_PUBLIC_*` — see [`src/config.ts`](./src/config.ts). Because
those values are public (they are bundled into the browser JavaScript), they
are NOT a place for secrets.

### One-time setup — copy the template

```bash
cd apps/web
cp .env.example .env.local
```

`.env.local` is git-ignored — your overrides stay on your machine. The
template ships with safe **testnet** defaults so the app starts; you only
need to fill in the four contract IDs emitted by the deploy script.

### Required variables

| Variable                                | Description                                    |
| --------------------------------------- | ---------------------------------------------- |
| `NEXT_PUBLIC_PRICE_VAULT_CONTRACT_ID`   | Deployed `PriceVault` Soroban contract address |
| `NEXT_PUBLIC_FLOW_REWARDS_CONTRACT_ID`  | Deployed `FlowRewards` contract address        |
| `NEXT_PUBLIC_SENTINEL_POOL_CONTRACT_ID` | Deployed `SentinelPool` contract address       |
| `NEXT_PUBLIC_KOVARA_INDEX_CONTRACT_ID`  | Deployed `KovaraIndex` contract address        |

The app validates these at startup via `requireEnv(...)` in
[`src/config.ts`](./src/config.ts) and will throw a clear error message if
any are missing.

### Where to get contract IDs

After deploying the Kovara contracts (see
[`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) and
`scripts/deploy_testnet.sh`), paste the four contract addresses into
`.env.local`. The same script prints them line-by-line in the format the
config expects.

### Network selection — testnet vs mainnet vs local

The template defaults to `NEXT_PUBLIC_STELLAR_NETWORK=testnet`. To target
mainnet, change that single variable to `mainnet` and overwrite the four
contract IDs with the mainnet deployments.

For a local Stellar quickstart sandbox:

```bash
NEXT_PUBLIC_STELLAR_NETWORK=testnet
NEXT_PUBLIC_HORIZON_URL=http://localhost:8000
NEXT_PUBLIC_SOROBAN_RPC_URL=http://localhost:8000/soroban/rpc
NEXT_PUBLIC_NETWORK_PASSPHRASE="Standalone Network ; February 2017"
```

(See [`src/config.ts`](./src/config.ts) for the full list and defaults.)

### Security — what NOT to put in `.env`

- ✅ Network selection, RPC endpoints, contract IDs and feature flags: safe.
- ❌ Private keys, seed phrases, database URLs, signing secrets: **never**.
  Anything prefixed `NEXT_PUBLIC_` ends up in the user"s browser bundle.
  For real secrets, use unprefixed variables in server-only API routes
  (or platform secret stores like Vercel env vars) that are never imported
  into a `"use client"` component.

The template in [`apps/web/.env.example`](./.env.example) restates this in
inline comments so it"s obvious to anyone reading the file.

---

## Run

From the repository root:

```bash
pnpm --filter apps-web dev
```

Or from this directory:

```bash
pnpm dev
```

The dev server starts on <http://localhost:3000>.

### Route map

| Route           | Purpose                                             |
| --------------- | --------------------------------------------------- |
| `/`             | Landing page                                        |
| `/post/new`     | Create a post — **route-level wallet-gated** (#122) |
| `/explore`      | Explore posts and contributors                      |
| `/profile/edit` | Edit your on-chain profile                          |

---

## Build and lint

```bash
pnpm build   # next build
pnpm lint    # placeholder (no eslint config yet — see apps/web/.gitignore)
pnpm format  # prettier --write .
```

---

## Project structure

```
apps/web/
├── config.ts                          # Centralised NEXT_PUBLIC_* env reads
├── next.config.mjs                    # Next.js config (default)
├── postcss.config.mjs                 # Tailwind v4 PostCSS plugin
├── tsconfig.json                      # @/* → src/* path alias
├── VALIDATION.md                      # Form-validation ruleset
├── .env.example                       # Tracked: documented env template
├── .gitignore                         # `.env*.local` excluded
└── src/
    ├── app/                           # Next.js App Router
    │   ├── layout.tsx                 # Wraps children in WalletProvider + NavBar
    │   ├── page.tsx                   # Landing page
    │   ├── post/new/page.tsx          # Wallet-gated composer (#122)
    │   ├── explore/page.tsx
    │   └── profile/edit/page.tsx
    ├── components/
    │   ├── NavBar.tsx
    │   ├── PostComposer.tsx
    │   ├── RequireWallet.tsx          # Reusable wallet guard (#122)
    │   ├── WalletProvider.tsx         # Freighter-backed wallet context
    │   ├── forms/                     # Validated form components
    │   └── onboarding/                # OnboardingFlow state components
    ├── hooks/
    │   └── useWallet.ts               # Re-exports + onboarding state machine
    └── lib/
        ├── createPost.ts              # On-chain post submission
        ├── validate.ts                # Pure validation utilities
        └── contract/                  # Soroban contract bindings
```

---

## See also

- [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) — overall system design
- [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) — deploying Kovara to testnet/mainnet
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — workflow and PR conventions
- [`packages/web/README.md`](../packages/web/README.md) — the older
  `pages`-based web app (kept for reference while `apps/web` takes over)
