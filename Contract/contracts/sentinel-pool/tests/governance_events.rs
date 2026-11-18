//! #1094: governance and threshold changes are observable.

use kovara_sentinel_pool::{SentinelPool, SentinelPoolClient};
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    Address, Env,
};

#[test]
fn governance_and_threshold_updates_emit_events() {
    let env = Env::default();
    let id = env.register_contract(None, SentinelPool);
    let client = SentinelPoolClient::new(&env, &id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin, &Address::generate(&env), &100, &10, &2);

    let before = env.events().all().events().len();
    client.set_governance(&admin, &Address::generate(&env));
    assert_eq!(env.events().all().events().len(), before + 1);

    client.set_threshold(&admin, &3);
    assert_eq!(env.events().all().events().len(), before + 2);
}

#[test]
fn refused_calls_emit_nothing() {
    let env = Env::default();
    let id = env.register_contract(None, SentinelPool);
    let client = SentinelPoolClient::new(&env, &id);
    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin, &Address::generate(&env), &100, &10, &2);

    let before = env.events().all().events().len();
    assert!(client.try_set_governance(&attacker, &attacker).is_err());
    assert!(client.try_set_threshold(&attacker, &5).is_err());
    assert_eq!(env.events().all().events().len(), before);
}
