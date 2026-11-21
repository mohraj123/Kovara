#![no_std]
//! `FlowRewards` releases rewards to verified submitters and verifiers.
//!
//! # Paginated reward history (CT-10)
//!
//! Every call to `grant` appends the grant ID to a per-recipient index stored
//! in persistent storage under `DataKey::RecipientIndex(recipient)`. The index
//! is an append-only `Vec<u64>` so offset-based cursors are stable: a new grant
//! appended after a page was handed to a caller never shifts earlier entries,
//! so the caller can page forward without seeing duplicates or skips.
//!
//! `reward_history(recipient, offset, limit)` returns a bounded, deterministic
//! page of `GrantRecord`s:
//!
//! * `limit` must be `1..=MAX_HISTORY_PAGE_SIZE`; anything else returns
//!   `Error::InvalidPageSize`.
//! * `offset` is the zero-based position in the per-recipient index to start
//!   from. An offset past the end returns an empty `Vec`.
//! * The returned `Vec` contains at most `limit` entries.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Map, Symbol,
    Vec,
};

// ── Constants ────────────────────────────────────────────────────────────────

/// Supported reward roles.
pub const ROLE_SUBMITTER: Symbol = symbol_short!("submitter");
pub const ROLE_VERIFIER: Symbol = symbol_short!("verifier");

/// Maximum number of grants accepted by one `grant_batch` call.
pub const MAX_BATCH: u32 = 20;

/// Maximum entries returned by one `reward_history` page.
pub const MAX_HISTORY_PAGE_SIZE: u32 = 50;

// ── Errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// `amount` is zero or negative.
    InvalidAmount = 1,
    /// The role is not `submitter` or `verifier`.
    UnsupportedRole = 2,
    /// A grant with this ID was already processed.
    DuplicateGrant = 3,
    /// The recipient has nothing to claim.
    NothingToClaim = 4,
    /// The grant exceeds the treasury funds available for the asset.
    InsufficientTreasury = 5,
    /// The claim exceeds the recipient's claimable balance.
    InsufficientClaimable = 6,
    /// A grant batch is empty or larger than `MAX_BATCH`.
    InvalidBatchSize = 7,
    /// The grant ID was not found in storage.
    GrantNotFound = 8,
    /// The grant was already fully claimed.
    GrantAlreadyClaimed = 9,
    /// The grant was already fully revoked.
    GrantAlreadyRevoked = 10,
    /// A bounded page size was zero or above `MAX_HISTORY_PAGE_SIZE`.
    InvalidPageSize = 11,
}

// ── Storage keys ─────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// `Map<(Address, Address), i128>` — total granted per (recipient, asset).
    Granted,
    /// `Map<(Address, Address), i128>` — total claimed per (recipient, asset).
    Claimed,
    /// `Map<Address, i128>` — treasury funds per asset.
    Treasury,
    /// `bool` sentinel — marks a grant ID as processed (deduplication).
    GrantId(u64),
    /// `GrantRecord` — full record for a single grant.
    GrantRecord(u64),
    /// The current rewards admin.
    Admin,
    /// `Vec<u64>` — per-recipient append-only grant-ID index (CT-10).
    RecipientIndex(Address),
}

// ── Types ─────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GrantRecord {
    pub recipient: Address,
    pub asset: Address,
    pub amount: i128,
    pub claimed: i128,
    pub revoked: i128,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct FlowRewards;

// ── Storage helpers ───────────────────────────────────────────────────────────

fn balances(env: &Env, key: &DataKey) -> Map<(Address, Address), i128> {
    env.storage()
        .instance()
        .get(key)
        .unwrap_or_else(|| Map::new(env))
}

fn treasury(env: &Env) -> Map<Address, i128> {
    env.storage()
        .instance()
        .get(&DataKey::Treasury)
        .unwrap_or_else(|| Map::new(env))
}

/// Append `grant_id` to the per-recipient index used by `reward_history`.
fn push_recipient_index(env: &Env, recipient: &Address, grant_id: u64) {
    let key = DataKey::RecipientIndex(recipient.clone());
    let mut index: Vec<u64> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    index.push_back(grant_id);
    env.storage().persistent().set(&key, &index);
}

#[contractimpl]
impl FlowRewards {
    // ── Treasury ──────────────────────────────────────────────────────────────

    /// Add funds to the treasury for `asset`.
    pub fn fund_treasury(
        env: Env,
        admin: Address,
        asset: Address,
        amount: i128,
    ) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        admin.require_auth();

        let mut funds = treasury(&env);
        let current = funds.get(asset.clone()).unwrap_or(0);
        funds.set(asset, current + amount);
        env.storage().instance().set(&DataKey::Treasury, &funds);
        Ok(())
    }

    // ── Grants ────────────────────────────────────────────────────────────────

    /// Record a reward grant to a verified participant.
    ///
    /// The grant is appended to the per-recipient index so it is reachable via
    /// `reward_history`.
    pub fn grant(
        env: Env,
        admin: Address,
        recipient: Address,
        asset: Address,
        role: Symbol,
        amount: i128,
        grant_id: u64,
    ) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if !Self::is_supported_role(&role) {
            return Err(Error::UnsupportedRole);
        }
        admin.require_auth();
        Self::apply_grant(&env, recipient, asset, amount, grant_id)
    }

    /// Record up to `MAX_BATCH` grants in one call. Each entry is
    /// `(recipient, role, asset, amount, grant_id)` and goes through the same
    /// checks as `grant`. Any failing entry aborts the whole call, so no
    /// partial batch is ever recorded.
    pub fn grant_batch(
        env: Env,
        admin: Address,
        entries: Vec<(Address, Symbol, Address, i128, u64)>,
    ) -> Result<(), Error> {
        if entries.is_empty() || entries.len() > MAX_BATCH {
            return Err(Error::InvalidBatchSize);
        }
        admin.require_auth();

        for (recipient, role, asset, amount, grant_id) in entries.iter() {
            if amount <= 0 {
                return Err(Error::InvalidAmount);
            }
            if !Self::is_supported_role(&role) {
                return Err(Error::UnsupportedRole);
            }
            Self::apply_grant(&env, recipient, asset, amount, grant_id)?;
        }
        Ok(())
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    /// Set the rewards admin and emit an `("admin", "changed")` event carrying
    /// the old admin (`None` on first set) and the new one. The current admin
    /// must authorize a change; the first set is authorized by the new admin.
    pub fn set_admin(env: Env, new_admin: Address) {
        let old: Option<Address> = env.storage().instance().get(&DataKey::Admin);
        match &old {
            Some(current) => current.require_auth(),
            None => new_admin.require_auth(),
        }
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events().publish(
            (symbol_short!("admin"), symbol_short!("changed")),
            (old, new_admin),
        );
    }

    /// The current rewards admin, if one has been set.
    pub fn admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    // ── Claims ────────────────────────────────────────────────────────────────

    /// Claim part or all of the recipient's claimable balance for `asset`.
    pub fn claim(
        env: Env,
        recipient: Address,
        asset: Address,
        amount: i128,
    ) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        recipient.require_auth();

        if amount > Self::claimable(env.clone(), recipient.clone(), asset.clone()) {
            return Err(Error::InsufficientClaimable);
        }

        // Walk the per-recipient index and allocate the claim across matching
        // grant records in insertion order.
        let index_key = DataKey::RecipientIndex(recipient.clone());
        let grant_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&index_key)
            .unwrap_or_else(|| Vec::new(&env));

        let mut remaining = amount;
        for i in 0..grant_ids.len() {
            if remaining == 0 {
                break;
            }
            let grant_id = grant_ids.get(i).unwrap();
            let record_key = DataKey::GrantRecord(grant_id);
            let mut record: GrantRecord = match env.storage().persistent().get(&record_key) {
                Some(r) => r,
                None => continue,
            };
            if record.asset != asset {
                continue;
            }
            let unclaimed = record.amount - record.claimed - record.revoked;
            if unclaimed <= 0 {
                continue;
            }
            let take = remaining.min(unclaimed);
            record.claimed += take;
            remaining -= take;
            env.storage().persistent().set(&record_key, &record);
        }

        let mut claimed = balances(&env, &DataKey::Claimed);
        let balance_key = (recipient, asset);
        let current = claimed.get(balance_key.clone()).unwrap_or(0);
        claimed.set(balance_key, current + amount);
        env.storage().instance().set(&DataKey::Claimed, &claimed);
        Ok(())
    }

    // ── Revocation ────────────────────────────────────────────────────────────

    /// Revoke the unclaimed portion of a grant and return it to the treasury.
    ///
    /// The processed grant ID and updated record are retained for auditability.
    pub fn revoke(env: Env, admin: Address, grant_id: u64) -> Result<i128, Error> {
        admin.require_auth();

        let key = DataKey::GrantRecord(grant_id);
        let mut record: GrantRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::GrantNotFound)?;

        let reclaimable = record.amount - record.claimed - record.revoked;
        if reclaimable == 0 {
            if record.claimed == record.amount {
                return Err(Error::GrantAlreadyClaimed);
            }
            return Err(Error::GrantAlreadyRevoked);
        }

        let mut granted = balances(&env, &DataKey::Granted);
        let balance_key = (record.recipient.clone(), record.asset.clone());
        let current = granted.get(balance_key.clone()).unwrap_or(0);
        granted.set(balance_key, current - reclaimable);

        let mut funds = treasury(&env);
        let available = funds.get(record.asset.clone()).unwrap_or(0);
        funds.set(record.asset.clone(), available + reclaimable);
        record.revoked += reclaimable;

        env.storage().instance().set(&DataKey::Granted, &granted);
        env.storage().instance().set(&DataKey::Treasury, &funds);
        env.storage().persistent().set(&key, &record);
        Ok(reclaimable)
    }

    // ── Reads ─────────────────────────────────────────────────────────────────

    /// Total rewards granted to `recipient` in `asset` (revoked amounts are
    /// subtracted as they are processed).
    pub fn total_granted(env: Env, recipient: Address, asset: Address) -> i128 {
        balances(&env, &DataKey::Granted)
            .get((recipient, asset))
            .unwrap_or(0)
    }

    /// Total rewards claimed by `recipient` in `asset`.
    pub fn total_claimed(env: Env, recipient: Address, asset: Address) -> i128 {
        balances(&env, &DataKey::Claimed)
            .get((recipient, asset))
            .unwrap_or(0)
    }

    /// Rewards earned but not yet claimed.
    pub fn claimable(env: Env, recipient: Address, asset: Address) -> i128 {
        Self::total_granted(env.clone(), recipient.clone(), asset.clone())
            - Self::total_claimed(env, recipient, asset)
    }

    /// Treasury funds available for new grants in `asset`.
    pub fn treasury_balance(env: Env, asset: Address) -> i128 {
        treasury(&env).get(asset).unwrap_or(0)
    }

    /// Whether a grant ID has already been processed.
    pub fn is_grant_processed(env: Env, grant_id: u64) -> bool {
        env.storage().persistent().has(&DataKey::GrantId(grant_id))
    }

    /// Amount revoked from a grant, retained as an audit record.
    pub fn revoked_amount(env: Env, grant_id: u64) -> i128 {
        let record: Option<GrantRecord> = env
            .storage()
            .persistent()
            .get(&DataKey::GrantRecord(grant_id));
        record.map(|r| r.revoked).unwrap_or(0)
    }

    // ── Paginated reward history (CT-10) ──────────────────────────────────────

    /// Return a bounded, deterministic page of grant records for `recipient`.
    ///
    /// `offset` is a zero-based position in the per-recipient append-only index.
    /// Because the index is append-only, an offset handed to a caller on one
    /// page call keeps pointing at the same record on every subsequent call —
    /// new grants never shift earlier entries.
    ///
    /// `limit` must be in `1..=MAX_HISTORY_PAGE_SIZE` (50); anything outside
    /// that range returns `Error::InvalidPageSize`.
    ///
    /// An `offset` beyond the end of the index returns an empty `Vec`.
    pub fn reward_history(
        env: Env,
        recipient: Address,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<GrantRecord>, Error> {
        if limit == 0 || limit > MAX_HISTORY_PAGE_SIZE {
            return Err(Error::InvalidPageSize);
        }

        let index_key = DataKey::RecipientIndex(recipient.clone());
        let grant_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&index_key)
            .unwrap_or_else(|| Vec::new(&env));

        let total = grant_ids.len();
        let mut page = Vec::new(&env);

        if offset >= total {
            return Ok(page);
        }

        let end = (offset + limit).min(total);
        for i in offset..end {
            let grant_id = grant_ids.get(i).unwrap();
            if let Some(record) = env
                .storage()
                .persistent()
                .get(&DataKey::GrantRecord(grant_id))
            {
                page.push_back(record);
            }
        }

        Ok(page)
    }

    /// Total number of grants recorded for `recipient`.
    ///
    /// Callers can use this to determine how many pages exist before iterating.
    pub fn grant_count(env: Env, recipient: Address) -> u32 {
        let key = DataKey::RecipientIndex(recipient);
        let index: Vec<u64> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env));
        index.len()
    }
}

// ── Private helpers ───────────────────────────────────────────────────────────

impl FlowRewards {
    /// Core grant logic shared by `grant` and `grant_batch`.
    ///
    /// Checks deduplication, treasury sufficiency, updates balances, writes the
    /// `GrantRecord`, and appends the ID to the per-recipient index.
    fn apply_grant(
        env: &Env,
        recipient: Address,
        asset: Address,
        amount: i128,
        grant_id: u64,
    ) -> Result<(), Error> {
        let grant_key = DataKey::GrantId(grant_id);
        if env.storage().persistent().has(&grant_key) {
            return Err(Error::DuplicateGrant);
        }

        let mut funds = treasury(env);
        let available = funds.get(asset.clone()).unwrap_or(0);
        if amount > available {
            return Err(Error::InsufficientTreasury);
        }
        funds.set(asset.clone(), available - amount);
        env.storage().instance().set(&DataKey::Treasury, &funds);

        let mut granted = balances(env, &DataKey::Granted);
        let balance_key = (recipient.clone(), asset.clone());
        let current = granted.get(balance_key.clone()).unwrap_or(0);
        granted.set(balance_key, current + amount);
        env.storage().instance().set(&DataKey::Granted, &granted);

        env.storage().persistent().set(
            &DataKey::GrantRecord(grant_id),
            &GrantRecord {
                recipient: recipient.clone(),
                asset,
                amount,
                claimed: 0,
                revoked: 0,
            },
        );
        // Mark the ID as processed (deduplication sentinel).
        env.storage().persistent().set(&grant_key, &true);
        // Append to per-recipient index for `reward_history`.
        push_recipient_index(env, &recipient, grant_id);
        Ok(())
    }

    fn is_supported_role(role: &Symbol) -> bool {
        *role == ROLE_SUBMITTER || *role == ROLE_VERIFIER
    }
}
