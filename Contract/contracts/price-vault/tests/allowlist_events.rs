//! #1081 CT-010 — allowlist removal events.
#![cfg(test)]

use kovara_price_vault::{Error, PriceVault};
use soroban_sdk::{
    testutils::{Address as _, Events},
    Address, Env, Symbol, Vec,
};

fn setup() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(PriceVault, ());
    env.as_contract(&id, || {
        PriceVault::initialize(env.clone(), admin.clone()).unwrap();
    });
    (env, id, admin)
}

#[test]
fn country_removal_emits_event() {
    let (env, id, admin) = setup();
    env.as_contract(&id, || {
        let us = Symbol::new(&env, "US");
        let ng = Symbol::new(&env, "NG");
        PriceVault::set_country_allowlist(
            env.clone(),
            admin.clone(),
            Vec::from_array(&env, [us.clone(), ng.clone()]),
        )
        .unwrap();
        let before = env.events().all().len();
        PriceVault::set_country_allowlist(
            env.clone(),
            admin,
            Vec::from_array(&env, [us]),
        )
        .unwrap();
        assert!(env.events().all().len() > before);
    });
}

#[test]
fn failed_update_emits_nothing() {
    let (env, id, admin) = setup();
    env.as_contract(&id, || {
        let before = env.events().all().len();
        let err = PriceVault::set_country_allowlist(
            env.clone(),
            admin,
            Vec::from_array(&env, [Symbol::new(&env, "ZZ")]),
        )
        .unwrap_err();
        assert_eq!(err, Error::InvalidCountry);
        assert_eq!(env.events().all().len(), before);
    });
}
