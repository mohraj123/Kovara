#![no_std]
//! `SentinelPool` — manages verifier staking, quorum logic, and slashing of
//! bad actors.
//!
//! CT-001 scaffolding: wires the contract to the Soroban SDK and provides a
//! minimal stake/read surface. The full staking, quorum and slashing state
//! machine is owned by later contract issues.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Map};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// Stake was zero or negative.
    InvalidStake = 1,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// `address` → total staked balance.
    Stakes,
}

#[contract]
pub struct SentinelPool;

#[contractimpl]
impl SentinelPool {
    pub fn stake(env: Env, sentinel: Address, amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidStake);
        }
        sentinel.require_auth();

        let mut stakes: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&DataKey::Stakes)
            .unwrap_or_else(|| Map::new(&env));

        let current = stakes.get(sentinel.clone()).unwrap_or(0);
        stakes.set(sentinel.clone(), current + amount);
        env.storage().instance().set(&DataKey::Stakes, &stakes);
        Ok(())
    }

    pub fn balance(env: Env, sentinel: Address) -> i128 {
        let stakes: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&DataKey::Stakes)
            .unwrap_or_else(|| Map::new(&env));
        stakes.get(sentinel).unwrap_or(0)
    }

    /// The number of sentinel signatures required for a quorum.
    pub fn quorum_threshold(env: Env, required: u32) -> u32 {
        let _ = env;
        required
    }
}
