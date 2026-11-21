use kovara_flow_rewards::{Error, FlowRewards, FlowRewardsClient, ROLE_SUBMITTER, ROLE_VERIFIER};
use soroban_sdk::{symbol_short, testutils::Address as _, Address, Env};

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
fn submitter_role_is_accepted() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &10, &1);
    assert_eq!(client.total_granted(&recipient, &asset), 10);
}

#[test]
fn verifier_role_is_accepted() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_VERIFIER, &10, &1);
    assert_eq!(client.total_granted(&recipient, &asset), 10);
}

#[test]
fn unknown_role_is_rejected() {
    let (_env, client, admin, recipient, asset) = setup();
    let result = client.try_grant(
        &admin,
        &recipient,
        &asset,
        &symbol_short!("hacker"),
        &10,
        &1,
    );
    assert_eq!(result, Err(Ok(Error::UnsupportedRole)));
    assert_eq!(client.total_granted(&recipient, &asset), 0);
}
