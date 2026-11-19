#![no_std]
//! `FlowRewards` — releases XLM / Stellar USDC to verified submitters and
//! verifiers.
//!
//! Balances are keyed by `(recipient, asset)` so grants in different assets
//! never merge into one ambiguous total. Grants are paid out of a per-asset
//! treasury, and earned and claimed totals are stored independently.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Map, Symbol, Vec,
};

/// Supported reward roles.
pub const ROLE_SUBMITTER: Symbol = symbol_short!("submitter");
pub const ROLE_VERIFIER: Symbol = symbol_short!("verifier");

/// Maximum number of grants accepted by one `grant_batch` call.
pub const MAX_BATCH: u32 = 20;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// A zero or negative reward amount.
    InvalidAmount = 1,
    /// The role is not a supported reward role.
    UnsupportedRole = 2,
    /// A grant with this ID was already processed.
    DuplicateGrant = 3,
    /// The recipient has nothing left to claim.
    NothingToClaim = 4,
    /// The grant exceeds the treasury funds available for the asset.
    InsufficientTreasury = 2,
    /// The claim exceeds the recipient's claimable balance.
    InsufficientClaimable = 3,
    /// A grant batch is empty or larger than `MAX_BATCH`.
    InvalidBatchSize = 6,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// `(recipient, asset)` → cumulative rewards granted.
    Granted,
    /// Marks a grant ID as already processed.
    GrantId(u64),
    /// `address` → cumulative rewards already claimed.
    Claimed(Address),
    /// `(recipient, asset)` → cumulative rewards claimed.
    Claimed,
    /// `asset` → treasury funds available for new grants.
    Treasury,
    /// The current rewards admin.
    Admin,
}

#[contract]
pub struct FlowRewards;

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

#[contractimpl]
impl FlowRewards {
    /// Add funds to the treasury for `asset`.
    pub fn fund_treasury(env: Env, admin: Address, asset: Address, amount: i128) -> Result<(), Error> {
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

    /// Record a reward grant to a verified participant.
    ///
    /// `grant_id` is an idempotency key: replaying the same ID is rejected
    /// without changing recipient totals.
    /// Refused before any state change when the treasury for `asset` cannot
    /// cover `amount`.
    pub fn grant(
        env: Env,
        admin: Address,
        recipient: Address,
        role: Symbol,
        asset: Address,
        _role: Symbol,
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
            if env.storage().persistent().has(&DataKey::GrantId(grant_id)) {
                return Err(Error::DuplicateGrant);
            }
            Self::apply_grant(&env, recipient, asset, amount, grant_id)?;
        }
        Ok(())
    }

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

    /// Claim all unclaimed rewards. Only the recipient can authorize this,
    /// and a claim cannot be replayed once the balance is taken.
    pub fn claim(env: Env, recipient: Address) -> Result<i128, Error> {
        recipient.require_auth();

        let total = Self::total_granted(env.clone(), recipient.clone());
        let claimed = Self::total_claimed(env.clone(), recipient.clone());
        let amount = total - claimed;
        if amount <= 0 {
            return Err(Error::NothingToClaim);
        }

        env.storage()
            .persistent()
            .set(&DataKey::Claimed(recipient), &total);
        Ok(amount)
    }

    /// Total rewards granted to an address so far.
    pub fn total_granted(env: Env, recipient: Address) -> i128 {
        let granted: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&DataKey::Granted)
            .unwrap_or_else(|| Map::new(&env));
        granted.get(recipient).unwrap_or(0)
    /// Claim part or all of the recipient's claimable balance for `asset`.
    pub fn claim(env: Env, recipient: Address, asset: Address, amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        recipient.require_auth();

        if amount > Self::claimable(env.clone(), recipient.clone(), asset.clone()) {
            return Err(Error::InsufficientClaimable);
        }

        let mut claimed = balances(&env, &DataKey::Claimed);
        let key = (recipient, asset);
        let current = claimed.get(key.clone()).unwrap_or(0);
        claimed.set(key, current + amount);
        env.storage().instance().set(&DataKey::Claimed, &claimed);
        Ok(())
    }

    /// Total rewards granted to `recipient` in `asset` so far.
    pub fn total_granted(env: Env, recipient: Address, asset: Address) -> i128 {
        balances(&env, &DataKey::Granted).get((recipient, asset)).unwrap_or(0)
    }

    /// Total rewards claimed by `recipient` in `asset` so far.
    pub fn total_claimed(env: Env, recipient: Address, asset: Address) -> i128 {
        balances(&env, &DataKey::Claimed).get((recipient, asset)).unwrap_or(0)
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

    /// Total rewards an address has already claimed.
    pub fn total_claimed(env: Env, recipient: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Claimed(recipient))
            .unwrap_or(0)
    }

    /// Whether a grant ID has already been processed.
    pub fn is_grant_processed(env: Env, grant_id: u64) -> bool {
        env.storage().persistent().has(&DataKey::GrantId(grant_id))
    }
}

impl FlowRewards {
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

        let mut granted: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&DataKey::Granted)
            .unwrap_or_else(|| Map::new(env));
        let current = granted.get(recipient.clone()).unwrap_or(0);
        granted.set(recipient.clone(), current + amount);
        let mut funds = treasury(env);
        let available = funds.get(asset.clone()).unwrap_or(0);
        if amount > available {
            return Err(Error::InsufficientTreasury);
        }
        funds.set(asset.clone(), available - amount);
        env.storage().instance().set(&DataKey::Treasury, &funds);

        let mut granted = balances(env, &DataKey::Granted);
        let key = (recipient, asset);
        let current = granted.get(key.clone()).unwrap_or(0);
        granted.set(key, current + amount);
        env.storage().instance().set(&DataKey::Granted, &granted);
        env.storage().persistent().set(&grant_key, &true);
        Ok(())
    }

    fn is_supported_role(role: &Symbol) -> bool {
        *role == ROLE_SUBMITTER || *role == ROLE_VERIFIER
    }
}
