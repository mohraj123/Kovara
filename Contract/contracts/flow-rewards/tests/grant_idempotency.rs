use kovara_flow_rewards::{Error, FlowRewards, FlowRewardsClient, ROLE_SUBMITTER, ROLE_VERIFIER};
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup() -> (Env, FlowRewardsClient<'static>, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(FlowRewards, ());
    let client = FlowRewardsClient::new(&env, &id);
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let asset = Address::generate(&env);
    client.fund_treasury(&admin, &asset, &1_000);
    (env, client, admin, recipient, asset)
}

#[test]
fn first_grant_is_recorded() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &10, &1);
    assert_eq!(client.total_granted(&recipient, &asset), 10);
    assert!(client.is_grant_processed(&1));
}

#[test]
fn replayed_grant_id_is_rejected() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &10, &1);
    let result = client.try_grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &10, &1);
    assert_eq!(result, Err(Ok(Error::DuplicateGrant)));
    assert_eq!(client.total_granted(&recipient, &asset), 10);
}

#[test]
fn distinct_grant_ids_both_apply() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &10, &1);
    client.grant(&admin, &recipient, &asset, &ROLE_VERIFIER, &5, &2);
    assert_eq!(client.total_granted(&recipient, &asset), 15);
}
