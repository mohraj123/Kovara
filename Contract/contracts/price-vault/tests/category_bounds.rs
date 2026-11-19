//! #1080 CT-009 — category-specific price bounds.
#![cfg(test)]

use kovara_price_vault::{Error, PriceVault, MAX_PRICE};
use soroban_sdk::{testutils::Address as _, Address, Env, Symbol};

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
fn default_is_global_max() {
    let (env, id, _) = setup();
    env.as_contract(&id, || {
        assert_eq!(
            PriceVault::get_category_max_price(env.clone(), Symbol::new(&env, "Food")),
            MAX_PRICE
        );
    });
}

#[test]
fn configured_limit_and_boundary() {
    let (env, id, admin) = setup();
    let submitter = Address::generate(&env);
    env.as_contract(&id, || {
        let food = Symbol::new(&env, "Food");
        let us = Symbol::new(&env, "US");
        PriceVault::set_category_max_price(env.clone(), admin.clone(), food.clone(), Some(500))
            .unwrap();
        assert_eq!(PriceVault::get_category_max_price(env.clone(), food.clone()), 500);
        assert_eq!(
            PriceVault::submit(env.clone(), submitter.clone(), us.clone(), food.clone(), 501, 1000, 3600)
                .unwrap_err(),
            Error::CategoryPriceExceeded
        );
        PriceVault::submit(env.clone(), submitter, us, food, 500, 1000, 3600).unwrap();
    });
}

#[test]
fn cannot_exceed_global_ceiling() {
    let (env, id, admin) = setup();
    env.as_contract(&id, || {
        assert_eq!(
            PriceVault::set_category_max_price(
                env.clone(),
                admin,
                Symbol::new(&env, "Food"),
                Some(MAX_PRICE + 1)
            )
            .unwrap_err(),
            Error::ValueAboveMaximum
        );
    });
}
