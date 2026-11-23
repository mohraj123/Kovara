//! #1088: pause and unpause emit a typed pause-state event.

use kovara_sentinel_pool::{SentinelPool, SentinelPoolClient};
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    Address, Env,
};

fn setup(env: &Env) -> (SentinelPoolClient<'_>, Address) {
    let id = env.register_contract(None, SentinelPool);
    let client = SentinelPoolClient::new(env, &id);
    let governance = Address::generate(env);
    env.mock_all_auths();
    client.initialize(&Address::generate(env), &governance, &100, &10, &2);
    (client, governance)
}

#[test]
fn pause_and_unpause_each_emit_one_event() {
    let env = Env::default();
    let (client, governance) = setup(&env);

    let before = env.events().all().events().len();
    client.pause(&governance);
    assert_eq!(env.events().all().events().len(), before + 1);

    client.unpause(&governance);
    assert_eq!(env.events().all().events().len(), before + 2);
}

#[test]
fn unauthorized_pause_and_unpause_emit_nothing() {
    let env = Env::default();
    let (client, _governance) = setup(&env);
    let attacker = Address::generate(&env);

    let before = env.events().all().events().len();
    assert!(client.try_pause(&attacker).is_err());
    assert_eq!(env.events().all().events().len(), before);

    assert!(client.try_unpause(&attacker).is_err());
    assert_eq!(env.events().all().events().len(), before);
}
