use kovara_flow_rewards::{Error, FlowRewards, FlowRewardsClient, ROLE_SUBMITTER};
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup(env: &Env) -> (FlowRewardsClient<'_>, Address, Address, Address) {
    env.mock_all_auths();
    let client = FlowRewardsClient::new(env, &env.register(FlowRewards, ()));
    let admin = Address::generate(env);
    let recipient = Address::generate(env);
    let asset = Address::generate(env);
    client.fund_treasury(&admin, &asset, &100);
    (client, admin, recipient, asset)
}

#[test]
fn funded_grant_reduces_treasury() {
    let env = Env::default();
    let (client, admin, recipient, asset) = setup(&env);
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &30, &1);
    assert_eq!(client.treasury_balance(&asset), 70);
    assert_eq!(client.total_granted(&recipient, &asset), 30);
}

#[test]
fn insufficient_treasury_is_rejected_without_state_change() {
    let env = Env::default();
    let (client, admin, recipient, asset) = setup(&env);
    let result =
        client.try_grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &101, &1);
    assert_eq!(result, Err(Ok(Error::InsufficientTreasury)));
    assert_eq!(client.treasury_balance(&asset), 100);
    assert_eq!(client.total_granted(&recipient, &asset), 0);
}

#[test]
fn exact_balance_grant_succeeds() {
    let env = Env::default();
    let (client, admin, recipient, asset) = setup(&env);
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &100, &1);
    assert_eq!(client.treasury_balance(&asset), 0);
}
