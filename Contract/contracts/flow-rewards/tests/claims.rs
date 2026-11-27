use kovara_flow_rewards::{Error, FlowRewards, FlowRewardsClient, ROLE_SUBMITTER};
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
fn claim_requires_recipient_auth() {
    let (env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &10, &1);
    client.claim(&recipient, &asset, &10);

    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, recipient);
}

#[test]
fn successful_claim_reduces_claimable() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &10, &1);
    client.claim(&recipient, &asset, &10);
    assert_eq!(client.total_claimed(&recipient, &asset), 10);
    assert_eq!(client.claimable(&recipient, &asset), 0);
}

#[test]
fn duplicate_claim_is_rejected() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &10, &1);
    client.claim(&recipient, &asset, &10);
    let result = client.try_claim(&recipient, &asset, &1);
    assert_eq!(result, Err(Ok(Error::InsufficientClaimable)));
}
