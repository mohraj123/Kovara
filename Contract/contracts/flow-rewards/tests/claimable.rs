use kovara_flow_rewards::{Error, FlowRewards, FlowRewardsClient, ROLE_SUBMITTER};
use soroban_sdk::{testutils::Address as _, Address, Env};

#[test]
fn claimable_tracks_grants_and_partial_claims() {
    let env = Env::default();
    env.mock_all_auths();
    let client = FlowRewardsClient::new(&env, &env.register(FlowRewards, ()));
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let asset = Address::generate(&env);

    client.fund_treasury(&admin, &asset, &1_000);
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &100, &1);
    assert_eq!(client.claimable(&recipient, &asset), 100);

    client.claim(&recipient, &asset, &40);
    assert_eq!(client.total_granted(&recipient, &asset), 100);
    assert_eq!(client.total_claimed(&recipient, &asset), 40);
    assert_eq!(client.claimable(&recipient, &asset), 60);

    client.claim(&recipient, &asset, &60);
    assert_eq!(client.claimable(&recipient, &asset), 0);

    let result = client.try_claim(&recipient, &asset, &1);
    assert_eq!(result, Err(Ok(Error::InsufficientClaimable)));
}
