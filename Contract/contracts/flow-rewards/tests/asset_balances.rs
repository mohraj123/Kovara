use kovara_flow_rewards::{FlowRewards, FlowRewardsClient, ROLE_SUBMITTER, ROLE_VERIFIER};
use soroban_sdk::{testutils::Address as _, Address, Env};

#[test]
fn balances_are_tracked_per_asset_and_recipient() {
    let env = Env::default();
    env.mock_all_auths();
    let client = FlowRewardsClient::new(&env, &env.register(FlowRewards, ()));
    let admin = Address::generate(&env);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let xlm = Address::generate(&env);
    let usdc = Address::generate(&env);

    client.fund_treasury(&admin, &xlm, &1_000);
    client.fund_treasury(&admin, &usdc, &1_000);
    client.grant(&admin, &alice, &xlm, &ROLE_SUBMITTER, &100, &1);
    client.grant(&admin, &alice, &usdc, &ROLE_SUBMITTER, &40, &2);
    client.grant(&admin, &bob, &xlm, &ROLE_VERIFIER, &7, &3);

    assert_eq!(client.total_granted(&alice, &xlm), 100);
    assert_eq!(client.total_granted(&alice, &usdc), 40);
    assert_eq!(client.total_granted(&bob, &xlm), 7);
    assert_eq!(client.total_granted(&bob, &usdc), 0);
}
