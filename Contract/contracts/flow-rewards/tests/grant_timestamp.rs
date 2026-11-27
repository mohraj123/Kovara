//! CT-09 — grant timestamps.
//!
//! Verifies that the ledger timestamp is stored with each grant and returned
//! both by `grant_timestamp` and in `GrantRecord`s from `reward_history`.

use kovara_flow_rewards::{FlowRewards, FlowRewardsClient, ROLE_SUBMITTER};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env,
};

fn setup() -> (Env, FlowRewardsClient<'static>, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(FlowRewards, ());
    let client = FlowRewardsClient::new(&env, &id);
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let asset = Address::generate(&env);
    client.fund_treasury(&admin, &asset, &100_000);
    (env, client, admin, recipient, asset)
}

fn set_timestamp(env: &Env, timestamp: u64) {
    env.ledger().with_mut(|ledger| ledger.timestamp = timestamp);
}

#[test]
fn grant_timestamp_is_recorded_from_the_ledger() {
    let (env, client, admin, recipient, asset) = setup();
    set_timestamp(&env, 1_700_000_000);

    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &100, &1);

    assert_eq!(client.grant_timestamp(&1), Some(1_700_000_000));
    let page = client.reward_history(&recipient, &0, &10);
    assert_eq!(page.get(0).unwrap().granted_at, 1_700_000_000);
}

#[test]
fn batch_grants_share_the_ledger_timestamp() {
    let (env, client, admin, recipient, asset) = setup();
    set_timestamp(&env, 42);
    let other = Address::generate(&env);
    let entries = soroban_sdk::vec![
        &env,
        (recipient.clone(), ROLE_SUBMITTER, asset.clone(), 10, 1u64),
        (other, ROLE_SUBMITTER, asset.clone(), 20, 2u64),
    ];

    client.grant_batch(&admin, &entries);

    assert_eq!(client.grant_timestamp(&1), Some(42));
    assert_eq!(client.grant_timestamp(&2), Some(42));
}

#[test]
fn timestamp_is_unchanged_by_claim_and_revoke() {
    let (env, client, admin, recipient, asset) = setup();
    set_timestamp(&env, 10);
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &100, &1);
    set_timestamp(&env, 20);
    client.claim(&recipient, &asset, &40);

    assert_eq!(client.grant_timestamp(&1), Some(10));

    set_timestamp(&env, 30);
    client.revoke(&admin, &1);
    assert_eq!(client.grant_timestamp(&1), Some(10));
}

#[test]
fn unknown_grant_has_no_timestamp() {
    let (_env, client, _admin, _recipient, _asset) = setup();
    assert_eq!(client.grant_timestamp(&99), None);
}
