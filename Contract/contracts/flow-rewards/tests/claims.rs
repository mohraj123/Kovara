use kovara_flow_rewards::{Error, FlowRewards, FlowRewardsClient, ROLE_SUBMITTER};
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
fn claim_requires_recipient_auth() {
    let (env, client, admin, recipient) = setup();
    client.grant(&admin, &recipient, &ROLE_SUBMITTER, &10, &1);
    client.claim(&recipient);

    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, recipient);
}

#[test]
fn successful_claim_returns_amount() {
    let (_env, client, admin, recipient) = setup();
    client.grant(&admin, &recipient, &ROLE_SUBMITTER, &10, &1);
    assert_eq!(client.claim(&recipient), 10);
    assert_eq!(client.total_claimed(&recipient), 10);
}

#[test]
fn duplicate_claim_is_rejected() {
    let (_env, client, admin, recipient) = setup();
    client.grant(&admin, &recipient, &ROLE_SUBMITTER, &10, &1);
    client.claim(&recipient);
    let result = client.try_claim(&recipient);
    assert_eq!(result, Err(Ok(Error::NothingToClaim)));
}
