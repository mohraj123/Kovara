use kovara_flow_rewards::{Error, FlowRewards, FlowRewardsClient, ROLE_SUBMITTER, ROLE_VERIFIER};
use soroban_sdk::{symbol_short, testutils::Address as _, Address, Env};

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
fn submitter_role_is_accepted() {
    let (_env, client, admin, recipient) = setup();
    client.grant(&admin, &recipient, &ROLE_SUBMITTER, &10, &1);
    assert_eq!(client.total_granted(&recipient), 10);
}

#[test]
fn verifier_role_is_accepted() {
    let (_env, client, admin, recipient) = setup();
    client.grant(&admin, &recipient, &ROLE_VERIFIER, &10, &1);
    assert_eq!(client.total_granted(&recipient), 10);
}

#[test]
fn unknown_role_is_rejected() {
    let (_env, client, admin, recipient) = setup();
    let result = client.try_grant(&admin, &recipient, &symbol_short!("hacker"), &10, &1);
    assert_eq!(result, Err(Ok(Error::UnsupportedRole)));
    assert_eq!(client.total_granted(&recipient), 0);
}
