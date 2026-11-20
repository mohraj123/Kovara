//! #1081 CT-010 — allowlist removal events.
#![cfg(test)]

use kovara_price_vault::{CountryAllowlistRemoved, Error, PriceVault, PriceVaultClient};
use soroban_sdk::{
    testutils::{Address as _, Events},
    Address, Env, Event, Symbol, Vec,
};

/// Each client call is its own contract invocation, so `require_auth` is
/// satisfied once per call and `events().all()` reports that call's events.
fn setup<'a>() -> (Env, Address, PriceVaultClient<'a>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(PriceVault, ());
    let client = PriceVaultClient::new(&env, &id);
    client.initialize(&admin);
    (env, id, client, admin)
}

#[test]
fn country_removal_emits_event() {
    let (env, id, client, admin) = setup();
    let us = Symbol::new(&env, "US");
    let ng = Symbol::new(&env, "NG");

    client.set_country_allowlist(&admin, &Vec::from_array(&env, [us.clone(), ng.clone()]));
    client.set_country_allowlist(&admin, &Vec::from_array(&env, [us]));

    let expected = CountryAllowlistRemoved {
        country_iso: ng,
        admin,
    };
    assert_eq!(env.events().all(), [expected.to_xdr(&env, &id)]);
}

#[test]
fn failed_update_emits_nothing() {
    let (env, _id, client, admin) = setup();
    let err = client
        .try_set_country_allowlist(&admin, &Vec::from_array(&env, [Symbol::new(&env, "ZZ")]))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::InvalidCountry);
    assert!(env.events().all().events().is_empty());
}
