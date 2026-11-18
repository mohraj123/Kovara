//! #1096: aggregate stake of eligible sentinels.

use kovara_sentinel_pool::{SentinelPool, SentinelPoolClient};
use soroban_sdk::{testutils::Address as _, vec, Address, Env};

fn setup(env: &Env) -> SentinelPoolClient<'_> {
    let id = env.register_contract(None, SentinelPool);
    let client = SentinelPoolClient::new(env, &id);
    env.mock_all_auths();
    client.initialize(
        &Address::generate(env),
        &Address::generate(env),
        &100,
        &10,
        &2,
    );
    client
}

#[test]
fn only_eligible_sentinels_are_counted() {
    let env = Env::default();
    let client = setup(&env);
    let eligible = Address::generate(&env);
    let deregistered = Address::generate(&env);
    client.stake(&eligible, &150);
    client.stake(&deregistered, &200);
    client.deregister(&deregistered);

    let sentinels = vec![&env, eligible, deregistered];
    assert_eq!(client.eligible_stake(&sentinels, &100, &10), 150);
}

#[test]
fn locked_sentinels_are_not_counted() {
    let env = Env::default();
    let client = setup(&env);
    let locked = Address::generate(&env);
    client.stake(&locked, &150);

    // Still inside the 10-ledger lock.
    assert_eq!(client.eligible_stake(&vec![&env, locked], &5, &10), 0);
}

#[test]
fn too_many_sentinels_is_rejected() {
    let env = Env::default();
    let client = setup(&env);
    let sentinels = vec![&env, Address::generate(&env), Address::generate(&env)];

    assert!(client.try_eligible_stake(&sentinels, &100, &1).is_err());
}

#[test]
fn empty_set_is_zero() {
    let env = Env::default();
    let client = setup(&env);
    assert_eq!(client.eligible_stake(&vec![&env], &100, &0), 0);
}
