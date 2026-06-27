# Kōvara

> **A decentralized, community-verified cost-of-living oracle built on the Stellar Network.**
> Submit local prices for bread, rent, transport, and utilities. Peers cross-verify on-chain.
> The output: a daily, tamper-evident, country-by-country purchasing-power index —
> incentivized entirely with XLM and Stellar USDC micro-rewards.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Network: Stellar](https://img.shields.io/badge/Network-Stellar-5D4ED3)](https://stellar.org)
[![Contracts: Soroban](https://img.shields.io/badge/Contracts-Soroban%20%28Rust%29-orange)](https://soroban.stellar.org)
[![Monorepo: pnpm](https://img.shields.io/badge/Monorepo-pnpm%20workspaces-blue)](https://pnpm.io)
[![Build: Turborepo](https://img.shields.io/badge/Build-Turborepo-black)](https://turbo.build)

---

## What is Kōvara?

*Kōvara* (कोवर) — a compound drawn from Sanskrit *kova* (price/value) and the Stellar concept of an open, borderless horizon.

Official cost-of-living indices are published annually, built on opaque methodology, and controlled by institutions. Crowd-sourced alternatives like Numbeo offer no submission incentives and no verifiability. Kōvara replaces both with a fully open, on-chain alternative:

| Gap in existing tools | Kōvara's answer |
|---|---|
| Slow, opaque CPI updates | Daily index published immutably on Stellar |
| No financial incentive to contribute | XLM + Stellar USDC micro-rewards per verified entry |
| Unverified, trust-required data | Peer-verification consensus — quorum recorded on-ledger |
| Centralized methodology | Open Soroban contracts — fork, audit, redeploy |
| Requires a bank account to participate | Works with any Stellar wallet on a basic smartphone |

---

## Monorepo Structure

```
kovara/
├── packages/
│   ├── contracts/      # @kovara/contracts  — Soroban smart contracts (Rust)
│   ├── sentinel/       # @kovara/sentinel   — Oracle daemon & aggregation node (TypeScript)
│   ├── api/            # @kovara/api        — Public REST + GraphQL data API (Node.js)
│   └── atlas/          # @kovara/atlas      — Contributor dApp & index explorer (Next.js)
├── docs/               # Architecture, whitepaper, methodology, API reference
├── scripts/            # Testnet bootstrap, seed data, deploy helpers
├── audits/             # Smart contract audit reports
├── pnpm-workspace.yaml
├── turbo.json
└── README.md           ← you are here
```

---

## Packages

### `@kovara/contracts`

Soroban smart contracts written in Rust, deployable to Stellar Testnet and Mainnet.

**Contracts:**

| Contract | Purpose |
|---|---|
| `PriceVault` | Stores raw price submissions keyed by `(country_iso, category, timestamp)` |
| `SentinelPool` | Manages verifier staking, quorum logic, and slashing of bad actors |
| `FlowRewards` | Releases XLM / Stellar USDC to verified submitters and verifiers |
| `KovaraIndex` | Aggregates verified prices into the daily `KVI` (Kōvara Value Index) per country |

```
packages/contracts/
├── src/
│   ├── price_vault.rs
│   ├── sentinel_pool.rs
│   ├── flow_rewards.rs
│   └── kovara_index.rs
├── tests/
│   ├── price_vault_test.rs
│   └── kovara_index_test.rs
├── Cargo.toml
└── README.md
```

**Stack:** Rust · Soroban SDK · Stellar CLI

---

### `@kovara/sentinel`

A lightweight daemon operated by community oracle nodes. Streams Stellar ledger events, batches verified price records, and submits daily index aggregations to the `KovaraIndex` contract.

**Responsibilities:**
- Stream `PriceSubmitted` events from `PriceVault` via Horizon
- Collect peer-verification votes; enforce quorum threshold
- Sign and submit daily aggregation transactions to `KovaraIndex`
- Emit Prometheus metrics for health monitoring

```
packages/sentinel/
├── src/
│   ├── listener.ts       # Stellar Horizon event streaming
│   ├── aggregator.ts     # Median calculation + outlier filtering
│   ├── submitter.ts      # Soroban contract invocation
│   └── metrics.ts        # Prometheus exporter
├── Dockerfile
├── package.json
└── README.md
```

**Stack:** TypeScript · `@stellar/stellar-sdk` · Horizon API · Docker · Prometheus

---

### `@kovara/api`

The public read layer. A REST + GraphQL API serving historical index data, country profiles, live submission feeds, and contributor leaderboards. Designed for third-party integrations — fintechs, NGOs, research tools, and academic datasets.

**REST Endpoints:**

```
GET  /v1/index/:country_iso                     Latest KVI for a country
GET  /v1/index/:country_iso/history?from=&to=   Historical range
GET  /v1/categories                             Price basket category definitions
GET  /v1/contributors/leaderboard               Top earners by XLM/USDC rewards
POST /v1/price                                  Submit a new price (wallet auth required)
```

```
packages/api/
├── src/
│   ├── routes/
│   ├── resolvers/        # GraphQL resolvers
│   ├── horizon/          # Stellar Horizon query helpers
│   └── cache/            # Redis caching layer
├── package.json
└── README.md
```

**Stack:** Node.js · Fastify · GraphQL Yoga · PostgreSQL · Redis · `@stellar/stellar-sdk`

---

### `@kovara/atlas`

The contributor-facing dApp and public index explorer. Connect a Stellar wallet, browse the price basket, submit verified prices, vote on peers, and track your earnings in real time.

**Pages:**

| Route | Description |
|---|---|
| `/` | Live global KVI map — country heat map by purchasing power |
| `/submit` | Price submission flow (Stellar wallet required) |
| `/verify` | Pending peer-verification queue |
| `/rewards` | XLM + USDC earnings history and pending claims |
| `/country/:iso` | Country-level index history, basket breakdown, contributors |
| `/methodology` | How the KVI is calculated — open and auditable |

```
packages/atlas/
├── app/                    # Next.js 14 App Router
├── components/
│   ├── IndexMap/           # Global choropleth map
│   ├── SubmitForm/         # Price submission wizard
│   ├── VerifyQueue/        # Verifier voting interface
│   └── RewardsPanel/       # Earnings dashboard
├── lib/
│   ├── stellar.ts          # Wallet integration (Freighter, LOBSTR, xBull)
│   └── contracts.ts        # Soroban contract clients (auto-generated)
├── package.json
└── README.md
```

**Stack:** Next.js 14 · TailwindCSS · `@stellar/stellar-sdk` · Freighter API · Recharts · D3

---

## How It Works

```
Contributor                Stellar Ledger                  Sentinel Node
    │                           │                               │
    ├── Submit price tx ────────▶ PriceVault.submit()           │
    │                           │◀──────────────────────────────┤ stream event
    │                           │                               ├ check quorum
    │◀── XLM micro-reward ──────┤ FlowRewards.pay()             │
    │                           │                               │
  [Peer Verifiers]              │                               │
    ├── Cast vote tx ───────────▶ SentinelPool.vote()           │
    │◀── USDC reward ───────────┤ FlowRewards.pay()             │
    │                           │                               │
    │                           │◀──────── daily aggregate ─────┤ KovaraIndex.update()
    │                           │                               │
    │                    KVI published on-chain                 │
    │                    (immutable · auditable)                │
```

### Price Basket Categories

| Category | Items tracked |
|---|---|
| Food | Bread, rice, milk, eggs, cooking oil |
| Rent | 1-bedroom city centre, 1-bedroom outside centre |
| Transport | Monthly pass, petrol per litre, taxi fare |
| Utilities | Electricity, internet (60 Mbps), water |
| Healthcare | GP visit, common prescription medication |

---

## Token Economics

Kōvara uses **no proprietary token**. All incentives flow through Stellar-native assets:

| Action | Asset | Estimated reward |
|---|---|---|
| Submit a price (verified by quorum) | XLM | ~0.05 XLM |
| Verify a peer submission (correct vote) | Stellar USDC | ~$0.02 |
| Operate a sentinel oracle node (daily) | XLM | ~2–10 XLM |
| Submit fraudulent data (slashed) | Stake deducted | Variable |

Reward pools are funded through a community treasury, replenished by B2B data licensing fees paid by commercial API consumers.

---

## Getting Started

### Prerequisites

- Node.js ≥ 20
- pnpm ≥ 9
- Rust stable + `soroban-cli`
- A funded Stellar Testnet account — get one via [Stellar Laboratory](https://laboratory.stellar.org/#account-creator)

### Quickstart

From the repository root, the fastest way to bring up the workspace is:

```bash
git clone https://github.com/kovara-protocol/kovara.git
cd kovara
pnpm install
pnpm dev
```

That installs all workspace dependencies and starts the monorepo development tasks through Turborepo.

For Rust contract testing, run:

```bash
cd packages/contracts
cargo test
```

To target a single workspace package, scope pnpm commands with `--filter`:

```bash
pnpm --filter @kovara/atlas dev
pnpm --filter @kovara/api build
pnpm --filter @kovara/contracts test
```

Package scoping uses the workspace definitions in `pnpm-workspace.yaml` and the package names declared in each package's `package.json`.

### Install

```bash
git clone https://github.com/kovara-protocol/kovara.git
cd kovara
pnpm install
```

### Build all packages

```bash
pnpm turbo build
```

### Run in development

```bash
# API + Atlas dApp in watch mode
pnpm turbo dev --filter=@kovara/api --filter=@kovara/atlas

# Sentinel oracle node against Testnet
pnpm --filter @kovara/sentinel start:testnet
```

### Deploy contracts to Testnet

```bash
cd packages/contracts
soroban contract build
bash ../../scripts/deploy_testnet.sh
```

---

## Open Data

All Kōvara index data is free and publicly accessible:

| Format | Access |
|---|---|
| REST API | `https://api.kovara.io/v1` |
| GraphQL | `https://api.kovara.io/graphql` |
| Daily CSV exports | `https://data.kovara.io/exports` |
| On-chain (Stellar Mainnet) | Contract `GCKOVARA...` via Stellar Expert |
| IPFS archive | Weekly immutable snapshots |

No API key required for read access. Rate limit: 1,000 requests/hour per IP.

---

## Contributing

```bash
# Fork the repo, then:
git checkout -b feat/your-feature

pnpm turbo test      # run all tests
pnpm turbo lint      # lint all packages

# Open a PR against `main`
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines and [docs/architecture.md](docs/architecture.md) for a full system deep-dive.

Good first issues: [`label:good-first-issue`](https://github.com/kovara-protocol/kovara/issues?q=label%3Agood-first-issue)

---

## Security

- Smart contracts audited by [TBD] — reports in [audits/](audits/)
- Responsible disclosure: security@kovara.io
- Bug bounty program: launching Q3 2025

---

## License

MIT © 2025 Kōvara Contributors

---

## Links

| | |
|---|---|
| Website | https://kovara.io |
| Docs | https://docs.kovara.io |
| Public API | https://api.kovara.io |
| X / Twitter | [@kovara_io](https://x.com/kovara_io) |
| Discord | https://discord.gg/kovara |
| Stellar Expert | [Contract explorer](https://stellar.expert) |

---

<p align="center">
  Built on <strong>Stellar</strong> · Powered by <strong>Soroban</strong> · Open data for the world 🌍
</p>