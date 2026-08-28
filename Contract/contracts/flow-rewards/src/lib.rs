#![no_std]
//! `FlowRewards` — releases XLM / Stellar USDC to verified submitters and
//! verifiers.
//!
//! CT-001 scaffolding: wires the contract to the Soroban SDK and provides a
//! minimal grant-tracking surface. Reward scheduling and treasury controls
//! are owned by later contract issues.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Map, Symbol};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// A zero or negative reward amount.
    InvalidAmount = 1,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// `address` → cumulative rewards granted, tracked to detect replay.
    Granted,
}

#[contract]
pub struct FlowRewards;

#[contractimpl]
impl FlowRewards {
    /// Record a reward grant to a verified participant.
    pub fn grant(
        env: Env,
        admin: Address,
        recipient: Address,
        _role: Symbol,
        amount: i128,
    ) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        admin.require_auth();

        let mut granted: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&DataKey::Granted)
            .unwrap_or_else(|| Map::new(&env));
        let current = granted.get(recipient.clone()).unwrap_or(0);
        granted.set(recipient.clone(), current + amount);
        env.storage().instance().set(&DataKey::Granted, &granted);
        Ok(())
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
}
