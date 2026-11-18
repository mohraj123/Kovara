#![no_std]
//! `FlowRewards` — releases XLM / Stellar USDC to verified submitters and
//! verifiers.
//!
//! Balances are keyed by `(recipient, asset)` so grants in different assets
//! never merge into one ambiguous total. Grants are paid out of a per-asset
//! treasury, and earned and claimed totals are stored independently.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Map, Symbol};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// A zero or negative reward amount.
    InvalidAmount = 1,
    /// The grant exceeds the treasury funds available for the asset.
    InsufficientTreasury = 2,
    /// The claim exceeds the recipient's claimable balance.
    InsufficientClaimable = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// `(recipient, asset)` → cumulative rewards granted.
    Granted,
    /// `(recipient, asset)` → cumulative rewards claimed.
    Claimed,
    /// `asset` → treasury funds available for new grants.
    Treasury,
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
    /// Refused before any state change when the treasury for `asset` cannot
    /// cover `amount`.
    pub fn grant(
        env: Env,
        admin: Address,
        recipient: Address,
        asset: Address,
        _role: Symbol,
        amount: i128,
    ) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        admin.require_auth();

        let mut funds = treasury(&env);
        let available = funds.get(asset.clone()).unwrap_or(0);
        if amount > available {
            return Err(Error::InsufficientTreasury);
        }
        funds.set(asset.clone(), available - amount);
        env.storage().instance().set(&DataKey::Treasury, &funds);

        let mut granted = balances(&env, &DataKey::Granted);
        let key = (recipient, asset);
        let current = granted.get(key.clone()).unwrap_or(0);
        granted.set(key, current + amount);
        env.storage().instance().set(&DataKey::Granted, &granted);
        Ok(())
    }

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
}
