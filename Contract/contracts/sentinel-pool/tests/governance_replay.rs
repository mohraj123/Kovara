//! #1097: governance proposals are bound to a unique, increasing id.

use kovara_sentinel_pool::{SentinelPool, SentinelPoolClient};
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup(env: &Env) -> (SentinelPoolClient<'_>, Address) {
    let id = env.register_contract(None, SentinelPool);
    let client = SentinelPoolClient::new(env, &id);
    let admin = Address::generate(env);
    env.mock_all_auths();
    client.initialize(&admin, &Address::generate(env), &100, &10, &2);
    (client, admin)
}

#[test]
fn proposal_ids_increase() {
    let env = Env::default();
    let (client, admin) = setup(&env);

    let first = client.propose_governance(&admin, &Address::generate(&env));
    let second = client.propose_governance(&admin, &Address::generate(&env));
    assert!(second > first);
}

#[test]
fn stale_proposal_cannot_be_accepted() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    let old = Address::generate(&env);
    let new = Address::generate(&env);

    let old_id = client.propose_governance(&admin, &old);
    let new_id = client.propose_governance(&admin, &new);

    assert!(client.try_accept_governance(&old, &old_id).is_err());
    client.accept_governance(&new, &new_id);
    assert_eq!(client.governance(), Some(new));
}

#[test]
fn repeated_acceptance_is_rejected() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    let gov = Address::generate(&env);

    let id = client.propose_governance(&admin, &gov);
    client.accept_governance(&gov, &id);
    assert!(client.try_accept_governance(&gov, &id).is_err());
}
