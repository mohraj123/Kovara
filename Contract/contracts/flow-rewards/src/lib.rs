#![no_std]
//! `FlowRewards` releases rewards to verified submitters and verifiers.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Map, Symbol,
    Vec,
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
    InvalidAmount = 1,
    UnsupportedRole = 2,
    DuplicateGrant = 3,
    NothingToClaim = 4,
    InsufficientTreasury = 5,
    InsufficientClaimable = 6,
    GrantNotFound = 7,
    GrantAlreadyClaimed = 8,
    GrantAlreadyRevoked = 9,
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
    Granted,
    Claimed,
    Treasury,
    GrantId(u64),
    GrantRecord(u64),
    GrantIds,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GrantRecord {
    pub recipient: Address,
    pub asset: Address,
    pub amount: i128,
    pub claimed: i128,
    pub revoked: i128,
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

    /// Record a reward grant to a verified participant.
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

        let mut funds = treasury(&env);
        let available = funds.get(asset.clone()).unwrap_or(0);
        if amount > available {
            return Err(Error::InsufficientTreasury);
        }

        let mut granted = balances(&env, &DataKey::Granted);
        let key = (recipient.clone(), asset.clone());
        let current = granted.get(key.clone()).unwrap_or(0);
        granted.set(key, current + amount);

        funds.set(asset.clone(), available - amount);
        env.storage().instance().set(&DataKey::Treasury, &funds);
        env.storage().instance().set(&DataKey::Granted, &granted);
        env.storage().persistent().set(
            &DataKey::GrantRecord(grant_id),
            &GrantRecord {
                recipient,
                asset,
                amount,
                claimed: 0,
                revoked: 0,
            },
        );
        env.storage().persistent().set(&grant_key, &true);
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

        let mut grant_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::GrantIds)
            .unwrap_or_else(|| Vec::new(&env));
        grant_ids.push_back(grant_id);
        env.storage()
            .persistent()
            .set(&DataKey::GrantIds, &grant_ids);
        Ok(())
    }

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

        let mut remaining = amount;
        let grant_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::GrantIds)
            .unwrap_or_else(|| Vec::new(&env));
        for index in 0..grant_ids.len() {
            if remaining == 0 {
                break;
            }
            let grant_id = grant_ids.get(index).unwrap();
            let key = DataKey::GrantRecord(grant_id);
            let mut record: GrantRecord = env.storage().persistent().get(&key).unwrap();
            if record.recipient != recipient || record.asset != asset {
                continue;
            }

            let unclaimed = record.amount - record.claimed - record.revoked;
            let claimed = remaining.min(unclaimed);
            if claimed > 0 {
                record.claimed += claimed;
                remaining -= claimed;
                env.storage().persistent().set(&key, &record);
            }
        }

        let mut claimed = balances(&env, &DataKey::Claimed);
        let key = (recipient, asset);
        let current = claimed.get(key.clone()).unwrap_or(0);
        claimed.set(key, current + amount);
        env.storage().instance().set(&DataKey::Claimed, &claimed);
        Ok(())
    }

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
        let amount = record.amount - record.claimed - record.revoked;
        if amount == 0 {
            if record.claimed == record.amount {
                return Err(Error::GrantAlreadyClaimed);
            }
            return Err(Error::GrantAlreadyRevoked);
        }

        let mut granted = balances(&env, &DataKey::Granted);
        let balance_key = (record.recipient.clone(), record.asset.clone());
        let current = granted.get(balance_key.clone()).unwrap_or(0);
        granted.set(balance_key, current - amount);

        let mut funds = treasury(&env);
        let available = funds.get(record.asset.clone()).unwrap_or(0);
        funds.set(record.asset.clone(), available + amount);
        record.revoked += amount;

        env.storage().instance().set(&DataKey::Granted, &granted);
        env.storage().instance().set(&DataKey::Treasury, &funds);
        env.storage().persistent().set(&key, &record);
        Ok(amount)
    }

    /// Total rewards granted to `recipient` in `asset`, excluding revoked amounts.
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
        record
            .map(|record| record.revoked)
            .unwrap_or(0)
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
