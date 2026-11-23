use kovara_flow_rewards::{Error, FlowRewards, FlowRewardsClient, ROLE_SUBMITTER};
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup() -> (Env, FlowRewardsClient<'static>, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(FlowRewards, ());
    let client = FlowRewardsClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let asset = Address::generate(&env);
    client.fund_treasury(&admin, &asset, &500);
    (env, client, admin, recipient, asset)
}

#[test]
fn revokes_unclaimed_grant_and_retains_audit_record() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &100, &1);

    assert_eq!(client.revoke(&admin, &1), 100);
    assert_eq!(client.total_granted(&recipient, &asset), 0);
    assert_eq!(client.claimable(&recipient, &asset), 0);
    assert_eq!(client.treasury_balance(&asset), 500);
    assert!(client.is_grant_processed(&1));
    assert_eq!(client.revoked_amount(&1), 100);
}

#[test]
fn revokes_only_the_unclaimed_portion_of_a_partially_claimed_grant() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &100, &2);
    client.claim(&recipient, &asset, &40);

    assert_eq!(client.revoke(&admin, &2), 60);
    assert_eq!(client.total_granted(&recipient, &asset), 40);
    assert_eq!(client.total_claimed(&recipient, &asset), 40);
    assert_eq!(client.claimable(&recipient, &asset), 0);
    assert_eq!(client.treasury_balance(&asset), 460);
    assert_eq!(client.revoked_amount(&2), 60);
}

#[test]
fn refuses_to_revoke_a_fully_claimed_grant() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &100, &3);
    client.claim(&recipient, &asset, &100);

    assert_eq!(
        client.try_revoke(&admin, &3),
        Err(Ok(Error::GrantAlreadyClaimed))
    );
    assert_eq!(client.total_granted(&recipient, &asset), 100);
    assert_eq!(client.total_claimed(&recipient, &asset), 100);
    assert_eq!(client.treasury_balance(&asset), 400);
    assert_eq!(client.revoked_amount(&3), 0);
}
