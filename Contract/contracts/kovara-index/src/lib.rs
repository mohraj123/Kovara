#![no_std]
//! `KovaraIndex` — aggregates verified prices into the daily `KVI`
//! (Kōvara Value Index) per country.
//!
//! CT-001 scaffolding: wires the contract to the Soroban SDK and stores one
//! daily index value per country/date. The aggregation, rounding, duplicate
//! rejection and authorization policies for the daily index are owned by
//! later contract issues.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Symbol};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// A zero date is reserved and never valid for a daily record.
    InvalidDate = 1,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// `(country, date)` → daily index value.
    DailyIndex(Symbol, u64),
}

#[contract]
pub struct KovaraIndex;

#[contractimpl]
impl KovaraIndex {
    /// Write one daily index value for a country/date.
    pub fn set_daily_index(
        env: Env,
        updater: Address,
        country: Symbol,
        date: u64,
        value: i128,
    ) -> Result<(), Error> {
        if date == 0 {
            return Err(Error::InvalidDate);
        }
        updater.require_auth();
        env.storage()
            .persistent()
            .set(&DataKey::DailyIndex(country.clone(), date), &value);
        Ok(())
    }

    /// Read a stored daily index value, if present.
    pub fn get_daily_index(env: Env, country: Symbol, date: u64) -> Option<i128> {
        env.storage().persistent().get(&DataKey::DailyIndex(country, date))
    }
}
