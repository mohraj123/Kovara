use kovara_flow_rewards::{FlowRewards, FlowRewardsClient};
use soroban_sdk::{symbol_short, testutils::Address as _, Address, Env};

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
    client.grant(&admin, &alice, &xlm, &symbol_short!("submit"), &100);
    client.grant(&admin, &alice, &usdc, &symbol_short!("submit"), &40);
    client.grant(&admin, &bob, &xlm, &symbol_short!("verify"), &7);

    assert_eq!(client.total_granted(&alice, &xlm), 100);
    assert_eq!(client.total_granted(&alice, &usdc), 40);
    assert_eq!(client.total_granted(&bob, &xlm), 7);
    assert_eq!(client.total_granted(&bob, &usdc), 0);
}
