use kovara_flow_rewards::{Error, FlowRewards, FlowRewardsClient, ROLE_SUBMITTER, ROLE_VERIFIER};
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup() -> (Env, FlowRewardsClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(FlowRewards, ());
    let client = FlowRewardsClient::new(&env, &id);
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    (env, client, admin, recipient)
}

#[test]
fn first_grant_is_recorded() {
    let (_env, client, admin, recipient) = setup();
    client.grant(&admin, &recipient, &ROLE_SUBMITTER, &10, &1);
    assert_eq!(client.total_granted(&recipient), 10);
    assert!(client.is_grant_processed(&1));
}

#[test]
fn replayed_grant_id_is_rejected() {
    let (_env, client, admin, recipient) = setup();
    client.grant(&admin, &recipient, &ROLE_SUBMITTER, &10, &1);
    let result = client.try_grant(&admin, &recipient, &ROLE_SUBMITTER, &10, &1);
    assert_eq!(result, Err(Ok(Error::DuplicateGrant)));
    assert_eq!(client.total_granted(&recipient), 10);
}

#[test]
fn distinct_grant_ids_both_apply() {
    let (_env, client, admin, recipient) = setup();
    client.grant(&admin, &recipient, &ROLE_SUBMITTER, &10, &1);
    client.grant(&admin, &recipient, &ROLE_VERIFIER, &5, &2);
    assert_eq!(client.total_granted(&recipient), 15);
}
