# @kovara/contracts

> Soroban smart contracts powering the Kōvara protocol — price submission, peer verification, reward distribution, and daily index aggregation — all written in Rust and deployed on the Stellar Network.

[![Network: Stellar](https://img.shields.io/badge/Network-Stellar-5D4ED3)](https://stellar.org)
[![Soroban SDK](https://img.shields.io/badge/Soroban-SDK%200.10-orange)](https://soroban.stellar.org)
[![Language: Rust](https://img.shields.io/badge/Language-Rust-CE422B)](https://www.rust-lang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

---

## Overview

`@kovara/contracts` contains all four Soroban smart contracts that form the on-chain backbone of the Kōvara protocol. Each contract has a single, clearly scoped responsibility and communicates with the others via cross-contract calls where necessary.

| Contract | Description |
|---|---|
| `PriceVault` | Stores raw price submissions keyed by country, category, and timestamp |
| `SentinelPool` | Manages verifier staking, vote casting, quorum resolution, and slashing |
| `FlowRewards` | Holds the reward treasury and releases XLM / Stellar USDC to contributors |
| `KovaraIndex` | Aggregates verified prices into the daily KVI (Kōvara Value Index) per country |

---

## Directory Structure

```
contracts/
├── src/
│   ├── price_vault.rs          # PriceVault contract
│   ├── sentinel_pool.rs        # SentinelPool contract
│   ├── flow_rewards.rs         # FlowRewards contract
│   ├── kovara_index.rs         # KovaraIndex contract
│   └── types.rs                # Shared types, enums, error codes
├── tests/
│   ├── price_vault_test.rs
│   ├── sentinel_pool_test.rs
│   ├── flow_rewards_test.rs
│   └── kovara_index_test.rs
├── scripts/
│   ├── deploy_testnet.sh       # Deploy all contracts to Testnet
│   ├── deploy_mainnet.sh       # Deploy to Mainnet (requires multisig)
│   └── seed_testnet.sh         # Seed Testnet with sample submissions
├── Cargo.toml
└── README.md                   ← you are here
```

---

## Storage Layout

The contract uses three Soroban storage buckets:

- `instance` for small protocol-wide counters and configuration
- `persistent` for user, post, pool, and relationship state
- `temporary` for short-lived cooldown tracking

### Instance Storage

| Key | Type | Purpose |
|---|---|---|
| `INIT` | `bool` | Marks the contract as initialized |
| `ADMIN` | `Address` | Protocol admin address |
| `TREASURY` | `Address` | Protocol treasury address for tip fees |
| `FEE_BPS` | `u32` | Protocol tip fee in basis points |
| `POST_CT` | `u64` | Total posts ever created |
| `PROF_CT` | `u64` | Total profiles ever created |
| `TIP_CD_W` | `u32` | Tip cooldown window in ledgers |

### Persistent Storage

All persistent application state is keyed through the `StorageKey` enum:

| Key | Value Type | Purpose |
|---|---|---|
| `Post(u64)` | `Post` | Post body and metadata by post ID |
| `Profile(Address)` | `Profile` | Profile data by user address |
| `Following(Address)` | `Vec<Address>` | Accounts followed by a user |
| `Followers(Address)` | `Vec<Address>` | Accounts following a user |
| `Pool(Symbol)` | `Pool` | Community pool state by pool ID |
| `Like(u64, Address)` | `bool` | Like marker for a post/user pair |
| `AuthorPosts(Address)` | `Vec<u64>` | Post IDs created by an author |
| `Blocks(Address)` | `Map<Address, ()>` | Block list for a blocker address |
| `UsernameIndex(String)` | `Address` | Reverse index from username to owner |

### Temporary Storage

| Key | Value Type | Purpose |
|---|---|---|
| `TipCooldown(u64, Address)` | `u32` | Last ledger sequence number for a tipper/post pair |

### Data Shapes

The main persisted structs are:

- `Post { id, author, content, tip_total, timestamp, like_count }`
- `Profile { address, username, creator_token }`
- `Pool { token, balance, admins, threshold }`
- `Proposal { id, pool_id, proposer, amount, recipient, signers, status }`

These values are stored directly under the keys above and are extended with TTL bumps on reads or mutations where applicable.
## Kovara Social Contract API Reference

The current Soroban implementation lives in `contracts/linkora-contracts/src/lib.rs` as `KovaraContract`. The implicit Soroban `Env` parameter is omitted from the inputs below.

| Method | Inputs | Auth requirements | Return value |
|---|---|---|---|
| `initialize` | `admin: Address`, `treasury: Address`, `fee_bps: u32` | None; intended as a one-time deployer call before public use. | `()`; stores admin, treasury, fee basis points, and default tip cooldown. Panics if already initialized or `fee_bps > 10000`. |
| `set_profile` | `user: Address`, `username: String`, `creator_token: Address` | `user.require_auth()` | `()`; creates or updates `Profile`, updates username reverse index, and emits `ProfileSetEvent`. |
| `get_profile` | `user: Address` | None | `Option<Profile>` for the address. |
| `get_profile_count` | None | None | `u64` profile counter. |
| `delete_profile` | `user: Address` | `user.require_auth()` | `()`; removes the profile and username index. Panics if the profile does not exist. |
| `get_address_by_username` | `username: String` | None | `Option<Address>` owner for the username. |
| `follow` | `follower: Address`, `followee: Address` | `follower.require_auth()` | `()`; adds the follow edge when absent and emits `FollowEvent`. Panics if `followee` has blocked `follower`. |
| `unfollow` | `follower: Address`, `followee: Address` | `follower.require_auth()` | `()`; removes the follow edge when present and emits `UnfollowEvent`. |
| `get_following` | `user: Address`, `offset: u32`, `limit: u32` | None | `Vec<Address>` page of accounts followed by `user`; `limit` must be 1 through 50. |
| `get_followers` | `user: Address`, `offset: u32`, `limit: u32` | None | `Vec<Address>` page of accounts following `user`; `limit` must be 1 through 50. |
| `block_user` | `blocker: Address`, `blocked: Address` | `blocker.require_auth()` | `()`; records the block and emits `BlockEvent`. |
| `unblock_user` | `blocker: Address`, `blocked: Address` | `blocker.require_auth()` | `()`; removes the block and emits `UnblockEvent`. |
| `is_blocked` | `blocker: Address`, `blocked: Address` | None | `bool` indicating whether `blocker` has blocked `blocked`. |
| `create_post` | `author: Address`, `content: String` | `author.require_auth()` | `u64` new post id; stores `Post`, indexes it by author, and emits `PostCreatedEvent`. |
| `get_post_count` | None | None | `u64` total posts ever created. Deleted posts do not decrement it. |
| `get_post` | `id: u64` | None | `Option<Post>` for the post id. |
| `delete_post` | `author: Address`, `post_id: u64` | `author.require_auth()` | `()`; removes the post and author index entry, then emits `PostDeleted`. Panics unless `author` owns the post. |
| `get_posts_by_author` | `author: Address`, `offset: u32`, `limit: u32` | None | `Vec<u64>` page of post ids by author; `limit` must be 1 through 50. |
| `like_post` | `user: Address`, `post_id: u64` | `user.require_auth()` | `()`; records a first-time like, increments `Post.like_count`, and emits `LikePostEvent`. Duplicate likes are no-ops. |
| `get_like_count` | `post_id: u64` | None | `u64` like count, or `0` when the post is missing. |
| `has_liked` | `user: Address`, `post_id: u64` | None | `bool` indicating whether `user` has liked the post. |
| `tip` | `tipper: Address`, `post_id: u64`, `token: Address`, `amount: i128` | `tipper.require_auth()` and token transfer authorization | `()`; transfers fee to treasury and net amount to post author, increments gross `tip_total`, and emits `TipEvent`. Panics for non-positive amount, missing post, block status, or active cooldown. |
| `create_pool` | `admin: Address`, `pool_id: Symbol`, `token: Address`, `initial_admins: Vec<Address>`, `threshold: u32` | `admin.require_auth()` and stored contract admin auth via `require_admin()` | `()`; creates a pool with zero balance and emits `PoolCreatedEvent`. Panics if the pool exists or threshold is invalid. |
| `pool_deposit` | `depositor: Address`, `pool_id: Symbol`, `token: Address`, `amount: i128` | `depositor.require_auth()` and token transfer authorization | `()`; transfers tokens into the contract, increases pool balance, and emits `PoolDepositEvent`. |
| `pool_withdraw` | `signers: Vec<Address>`, `pool_id: Symbol`, `amount: i128`, `recipient: Address` | Each address in `signers` must be a pool admin and must authorize | `()`; transfers pool tokens to `recipient`, decreases balance, and emits `PoolWithdrawEvent`. Panics for insufficient signers, unauthorized signer, or low balance. |
| `get_pool` | `pool_id: Symbol` | None | `Option<Pool>` for the pool id. |
| `get_pool_admins` | `pool_id: Symbol` | None | `Vec<Address>` admin list. Panics if the pool does not exist. |
| `add_pool_admin` | `signers: Vec<Address>`, `pool_id: Symbol`, `new_admin: Address` | Threshold number of existing pool admins in `signers` must authorize | `()`; appends `new_admin` and emits `PoolAdminAddedEvent`. Panics if the pool is missing, auth threshold fails, or admin already exists. |
| `remove_pool_admin` | `signers: Vec<Address>`, `pool_id: Symbol`, `admin: Address` | Threshold number of existing pool admins in `signers` must authorize | `()`; removes `admin` and emits `PoolAdminRemovedEvent`. Panics if removal would make the threshold unreachable. |
| `update_pool_threshold` | `signers: Vec<Address>`, `pool_id: Symbol`, `threshold: u32` | Threshold number of existing pool admins in `signers` must authorize | `()`; updates the M-of-N threshold and emits `PoolThresholdUpdatedEvent`. Panics if the new threshold is zero or exceeds admin count. |
| `set_fee` | `fee_bps: u32` | Stored contract admin auth via `require_admin()` | `()`; updates protocol fee basis points and emits `FeeUpdatedEvent`. Panics if `fee_bps > 10000`. |
| `set_treasury` | `treasury: Address` | Stored contract admin auth via `require_admin()` | `()`; updates treasury address and emits `TreasuryUpdatedEvent`. |
| `get_fee_bps` | None | None | `u32` protocol fee basis points, defaulting to `0` if unset. |
| `get_treasury` | None | None | `Option<Address>` treasury address. |
| `set_tip_cooldown_window` | `cooldown_ledgers: u32` | Stored contract admin auth via `require_admin()` | `()`; updates the per-tipper, per-post cooldown window. Panics if `cooldown_ledgers == 0`. |
| `get_tip_cooldown_window` | None | None | `u32` cooldown ledger count, defaulting to `1` if unset. |
| `upgrade` | `new_wasm_hash: BytesN<32>` | Stored contract admin auth via `require_admin()` | `()`; updates the current contract WASM and emits `ContractUpgraded`. |

---

## Contract Details

### `PriceVault`

The entry point for all price submissions. Stores raw, unverified prices on-ledger and emits events consumed by the `@kovara/sentinel` oracle daemon.

**Storage keys:**
```
submission:{country_iso}:{category}:{submitter_address}:{timestamp}
```

**Interface:**

```rust
// Submit a new price entry
fn submit(
    env: Env,
    submitter: Address,
    country_iso: Symbol,
    category: Symbol,
    price_usd_cents: u64,
    currency_local: Symbol,
    price_local: u64,
) -> Result<u64, Error>;   // returns submission_id

// Read a single submission
fn get_submission(env: Env, submission_id: u64) -> Option<Submission>;

// Read all pending (unverified) submissions for a country
fn pending(env: Env, country_iso: Symbol) -> Vec<Submission>;
```

**Events emitted:**
- `PriceSubmitted { submission_id, submitter, country_iso, category, timestamp }`

---

### `SentinelPool`

Controls the peer-verification layer. Verifiers stake XLM to participate. Each submission requires a quorum of `N` votes (default: 3) before being considered verified. Bad actors who vote against consensus lose a portion of their stake.

**Interface:**

```rust
// Stake XLM to join the verifier pool
fn stake(env: Env, verifier: Address, amount: i128) -> Result<(), Error>;

// Cast a verification vote on a submission
fn vote(
    env: Env,
    verifier: Address,
    submission_id: u64,
    verdict: Verdict,   // Approve | Reject
) -> Result<(), Error>;

// Resolve quorum for a submission (called by Sentinel Node)
fn resolve(env: Env, submission_id: u64) -> Resolution;

// Withdraw stake (subject to unbonding period)
fn unstake(env: Env, verifier: Address) -> Result<i128, Error>;
```

**Slashing rules:**
- Vote in the minority on a resolved submission → lose 5% of stake
- Vote on 10+ submissions in the minority in 30 days → stake frozen pending review

---

### `FlowRewards`

Holds the protocol's reward treasury (XLM + Stellar USDC). Releases rewards after the `SentinelPool` resolves a submission. Only callable by `SentinelPool` and `KovaraIndex` via cross-contract calls.

**Interface:**

```rust
// Pay a contributor after a verified submission
fn pay_submitter(
    env: Env,
    recipient: Address,
    submission_id: u64,
) -> Result<(), Error>;

// Pay a verifier after a resolved vote
fn pay_verifier(
    env: Env,
    recipient: Address,
    submission_id: u64,
) -> Result<(), Error>;

// Top up the treasury (governance / B2B licensing inflow)
fn fund(env: Env, funder: Address, amount: i128, asset: Asset) -> Result<(), Error>;

// Read current treasury balances
fn balances(env: Env) -> TreasuryBalance;
```

**Reward rates (configurable via governance):**

| Action | Default rate |
|---|---|
| Verified submission | 0.05 XLM |
| Correct verifier vote | 0.02 USDC |
| Oracle node daily aggregation | 2 XLM |

---

### `KovaraIndex`

Invoked once per day by the `@kovara/sentinel` oracle daemon. Reads all submissions verified within the past 24 hours, computes the trimmed median per category per country, and writes the resulting KVI snapshot on-chain.

**Interface:**

```rust
// Aggregate and publish the daily index (sentinel nodes only)
fn update_index(
    env: Env,
    caller: Address,
    country_iso: Symbol,
    date: u64,                 // Unix timestamp (UTC midnight)
) -> Result<KviSnapshot, Error>;

// Read the latest index for a country
fn latest(env: Env, country_iso: Symbol) -> Option<KviSnapshot>;

// Read a historical snapshot
fn history(
    env: Env,
    country_iso: Symbol,
    from: u64,
    to: u64,
) -> Vec<KviSnapshot>;
```

**Aggregation methodology:**
1. Collect all submissions for `country_iso` verified in the last 24h
2. Group by `category`
3. Apply 10% trimmed mean (drop top and bottom 10% of values)
4. Convert all values to USD cents using Stellar DEX price feeds
5. Compute composite KVI score (weighted basket average)
6. Write `KviSnapshot` to ledger storage

---

## Local Development

### Prerequisites

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Soroban CLI
cargo install --locked soroban-cli

# Add wasm32 target
rustup target add wasm32-unknown-unknown
```

### Build

```bash
# From the contracts/ directory
cargo build --target wasm32-unknown-unknown --release
```

Or use the workspace-level build:

```bash
# From repo root
pnpm turbo build --filter=@kovara/contracts
```

### Test

```bash
cargo test
```

Tests run against the Soroban sandbox (no live network required).

### Deploy to Testnet

```bash
# Set your Testnet keypair
export KOVARA_DEPLOYER_SECRET=S...

bash scripts/deploy_testnet.sh
```

The script deploys all four contracts in dependency order and writes their addresses to `deployed/testnet.json`.

### Deploy to Mainnet

Mainnet deployment requires a 2-of-3 multisig from the Kōvara core team. See [docs/deployment.md](../../docs/deployment.md).

---

## Contract Addresses

| Network | Contract | Address |
|---|---|---|
| Testnet | PriceVault | `GCPV...` |
| Testnet | SentinelPool | `GCSP...` |
| Testnet | FlowRewards | `GCFR...` |
| Testnet | KovaraIndex | `GCKI...` |
| Mainnet | All | TBD — launching Q3 2025 |

---

## Audits

| Auditor | Scope | Date | Report |
|---|---|---|---|
| TBD | All contracts | Q2 2025 | [audits/](../../audits/) |

---

## Error Codes

| Code | Name | Description |
|---|---|---|
| `1001` | `Unauthorized` | Caller is not permitted for this action |
| `1002` | `AlreadySubmitted` | Duplicate submission within cooldown window |
| `1003` | `QuorumNotReached` | Insufficient votes to resolve |
| `1004` | `InsufficientStake` | Verifier stake below minimum threshold |
| `1005` | `TreasuryEmpty` | Reward pool has insufficient funds |
| `1006` | `InvalidCountry` | Unrecognised ISO country code |
| `1007` | `InvalidCategory` | Unrecognised price basket category |

---

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md). For contract-specific changes, all PRs must include:

- Unit tests covering the changed logic
- A brief description of any storage schema changes
- Gas usage benchmarks if the change affects hot paths

---

## License

MIT © 2025 Kōvara Contributors
