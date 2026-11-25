use kovara_flow_rewards::{Error, FlowRewards, FlowRewardsClient, ROLE_SUBMITTER, ROLE_VERIFIER};
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup() -> (Env, FlowRewardsClient<'static>, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(FlowRewards, ());
    let client = FlowRewardsClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let asset = Address::generate(&env);
    client.fund_treasury(&admin, &asset, &1_000);
    // Configure the admin so `require_admin_if_configured` is enforced.
    client.set_admin(&admin);
    (env, client, admin, recipient, asset)
}

#[test]
fn reverses_part_of_a_grant_and_updates_all_views() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &100, &1);

    assert_eq!(client.reverse_grant(&admin, &1, &30), 30);
    assert_eq!(client.total_granted(&recipient, &asset), 70);
    assert_eq!(
        client.total_granted_by_role(&recipient, &asset, &ROLE_SUBMITTER),
        70
    );
    assert_eq!(client.claimable(&recipient, &asset), 70);
    assert_eq!(client.revoked_amount(&1), 30);
    assert_eq!(client.treasury_balance(&asset), 930);
}

#[test]
fn allows_multiple_reversals_up_to_the_remaining_balance() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_VERIFIER, &100, &1);

    assert_eq!(client.reverse_grant(&admin, &1, &25), 25);
    assert_eq!(client.reverse_grant(&admin, &1, &75), 75);

    assert_eq!(client.revoked_amount(&1), 100);
    assert_eq!(
        client.total_granted_by_role(&recipient, &asset, &ROLE_VERIFIER),
        0
    );
    assert_eq!(client.total_granted(&recipient, &asset), 0);
    assert_eq!(client.treasury_balance(&asset), 1_000);
}

#[test]
fn rejects_reversal_above_the_remaining_balance_without_mutating_state() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &100, &1);
    client.reverse_grant(&admin, &1, &40);

    assert_eq!(
        client.try_reverse_grant(&admin, &1, &61),
        Err(Ok(Error::ReversalExceedsGrant))
    );

    // The rejected call must not move any funds or totals.
    assert_eq!(client.revoked_amount(&1), 40);
    assert_eq!(client.total_granted(&recipient, &asset), 60);
    assert_eq!(client.treasury_balance(&asset), 940);
}

#[test]
fn rejects_duplicate_reversal_of_a_fully_reversed_grant() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &100, &1);
    client.reverse_grant(&admin, &1, &100);

    assert_eq!(
        client.try_reverse_grant(&admin, &1, &1),
        Err(Ok(Error::GrantAlreadyRevoked))
    );
    assert_eq!(client.revoked_amount(&1), 100);
    assert_eq!(client.total_granted(&recipient, &asset), 0);
    assert_eq!(client.treasury_balance(&asset), 1_000);
}

#[test]
fn rejects_reversal_of_a_fully_claimed_grant() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &100, &1);
    client.claim(&recipient, &asset, &100);

    assert_eq!(
        client.try_reverse_grant(&admin, &1, &1),
        Err(Ok(Error::GrantAlreadyClaimed))
    );
    assert_eq!(client.revoked_amount(&1), 0);
    assert_eq!(client.total_claimed(&recipient, &asset), 100);
}

#[test]
fn only_reverses_the_unclaimed_portion_of_a_partially_claimed_grant() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &100, &1);
    client.claim(&recipient, &asset, &40);

    assert_eq!(client.reverse_grant(&admin, &1, &60), 60);
    assert_eq!(
        client.try_reverse_grant(&admin, &1, &1),
        Err(Ok(Error::GrantAlreadyRevoked))
    );
    assert_eq!(client.total_granted(&recipient, &asset), 40);
    assert_eq!(client.total_claimed(&recipient, &asset), 40);
    assert_eq!(client.revoked_amount(&1), 60);
}

#[test]
fn rejects_unknown_grant_and_non_positive_amount() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &100, &1);

    assert_eq!(
        client.try_reverse_grant(&admin, &99, &10),
        Err(Ok(Error::GrantNotFound))
    );
    assert_eq!(
        client.try_reverse_grant(&admin, &1, &0),
        Err(Ok(Error::InvalidAmount))
    );
}

#[test]
fn rejects_a_non_admin_caller() {
    let (env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &100, &1);
    let attacker = Address::generate(&env);

    assert_eq!(
        client.try_reverse_grant(&attacker, &1, &10),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(client.revoked_amount(&1), 0);
    assert_eq!(client.total_granted(&recipient, &asset), 100);
}
