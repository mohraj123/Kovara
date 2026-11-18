#![no_std]
//! `FlowRewards` — releases XLM / Stellar USDC to verified submitters and
//! verifiers.
//!
//! CT-001 scaffolding: wires the contract to the Soroban SDK and provides a
//! minimal grant-tracking surface. Reward scheduling and treasury controls
//! are owned by later contract issues.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Map, Symbol,
};

/// Supported reward roles.
pub const ROLE_SUBMITTER: Symbol = symbol_short!("submitter");
pub const ROLE_VERIFIER: Symbol = symbol_short!("verifier");

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
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// `address` → cumulative rewards granted, tracked to detect replay.
    Granted,
    /// Marks a grant ID as already processed.
    GrantId(u64),
    /// `address` → cumulative rewards already claimed.
    Claimed(Address),
}

#[contract]
pub struct FlowRewards;

#[contractimpl]
impl FlowRewards {
    /// Record a reward grant to a verified participant.
    ///
    /// `grant_id` is an idempotency key: replaying the same ID is rejected
    /// without changing recipient totals.
    pub fn grant(
        env: Env,
        admin: Address,
        recipient: Address,
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

        let grant_key = DataKey::GrantId(grant_id);
        if env.storage().persistent().has(&grant_key) {
            return Err(Error::DuplicateGrant);
        }

        let mut granted: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&DataKey::Granted)
            .unwrap_or_else(|| Map::new(&env));
        let current = granted.get(recipient.clone()).unwrap_or(0);
        granted.set(recipient.clone(), current + amount);
        env.storage().instance().set(&DataKey::Granted, &granted);
        env.storage().persistent().set(&grant_key, &true);
        Ok(())
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
    fn is_supported_role(role: &Symbol) -> bool {
        *role == ROLE_SUBMITTER || *role == ROLE_VERIFIER
    }
}
