use kovara_flow_rewards::{
    Error, FlowRewards, FlowRewardsClient, ROLE_SUBMITTER, ROLE_VERIFIER, SUPPORTED_ROLES,
};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _},
    Address, Env, IntoVal, Val, Vec,
};

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
    assert_eq!(
        client.total_granted_by_role(&recipient, &asset, &symbol_short!("hacker")),
        0
    );
}

#[test]
fn supported_roles_are_submitter_and_verifier() {
    assert_eq!(SUPPORTED_ROLES, [ROLE_SUBMITTER, ROLE_VERIFIER]);
}

#[test]
fn unknown_role_leaves_storage_untouched_and_id_reusable() {
    let (_env, client, admin, recipient, asset) = setup();
    let unknown = symbol_short!("hacker");

    assert_eq!(
        client.try_grant(&admin, &recipient, &asset, &unknown, &10, &1),
        Err(Ok(Error::UnsupportedRole))
    );
    assert_eq!(client.treasury_balance(&asset), 1_000);
    assert_eq!(client.total_granted(&recipient, &asset), 0);
    assert_eq!(
        client.total_granted_by_role(&recipient, &asset, &unknown),
        0
    );
    assert_eq!(client.grant_count(&recipient), 0);
    assert!(!client.is_grant_processed(&1));

    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &10, &1);
    assert_eq!(client.total_granted(&recipient, &asset), 10);
}

#[test]
fn unknown_role_in_batch_rejects_before_any_entry_is_written() {
    let (env, client, admin, recipient, asset) = setup();
    let other = Address::generate(&env);
    let unknown = symbol_short!("hacker");

    let result = client.try_grant_batch(
        &admin,
        &Vec::from_array(
            &env,
            [
                (recipient.clone(), ROLE_SUBMITTER, asset.clone(), 10, 1),
                (other.clone(), unknown, asset.clone(), 20, 2),
            ],
        ),
    );
    assert_eq!(result, Err(Ok(Error::UnsupportedRole)));

    assert_eq!(client.treasury_balance(&asset), 1_000);
    assert_eq!(client.total_granted(&recipient, &asset), 0);
    assert_eq!(client.total_granted(&other, &asset), 0);
    assert_eq!(client.grant_count(&recipient), 0);
    assert_eq!(client.grant_count(&other), 0);
    assert!(!client.is_grant_processed(&1));
    assert!(!client.is_grant_processed(&2));

    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &10, &1);
    assert_eq!(client.total_granted(&recipient, &asset), 10);
}

#[test]
fn role_totals_are_independent_for_the_same_recipient_and_asset() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &10, &1);
    client.grant(&admin, &recipient, &asset, &ROLE_VERIFIER, &25, &2);

    assert_eq!(
        client.total_granted_by_role(&recipient, &asset, &ROLE_SUBMITTER),
        10
    );
    assert_eq!(
        client.total_granted_by_role(&recipient, &asset, &ROLE_VERIFIER),
        25
    );
    // The compatibility view keeps its original meaning: the sum of roles.
    assert_eq!(client.total_granted(&recipient, &asset), 35);
    assert_eq!(client.claimable(&recipient, &asset), 35);
}

#[test]
fn role_totals_are_scoped_to_each_recipient() {
    let (env, client, admin, _, asset) = setup();
    let submitter = Address::generate(&env);
    let verifier = Address::generate(&env);

    client.grant(&admin, &submitter, &asset, &ROLE_SUBMITTER, &10, &1);
    client.grant(&admin, &verifier, &asset, &ROLE_SUBMITTER, &30, &2);

    assert_eq!(
        client.total_granted_by_role(&submitter, &asset, &ROLE_SUBMITTER),
        10
    );
    assert_eq!(
        client.total_granted_by_role(&verifier, &asset, &ROLE_SUBMITTER),
        30
    );
    assert_eq!(
        client.total_granted_by_role(&verifier, &asset, &ROLE_VERIFIER),
        0
    );
    assert_eq!(client.total_granted(&submitter, &asset), 10);
    assert_eq!(client.total_granted(&verifier, &asset), 30);
}

#[test]
fn grant_batch_tracks_each_role_independently() {
    let (env, client, admin, recipient, asset) = setup();
    let other = Address::generate(&env);

    client.grant_batch(
        &admin,
        &soroban_sdk::vec![
            &env,
            (recipient.clone(), ROLE_SUBMITTER, asset.clone(), 10, 1),
            (recipient.clone(), ROLE_VERIFIER, asset.clone(), 20, 2),
            (other.clone(), ROLE_SUBMITTER, asset.clone(), 5, 3),
        ],
    );

    assert_eq!(
        client.total_granted_by_role(&recipient, &asset, &ROLE_SUBMITTER),
        10
    );
    assert_eq!(
        client.total_granted_by_role(&recipient, &asset, &ROLE_VERIFIER),
        20
    );
    assert_eq!(
        client.total_granted_by_role(&other, &asset, &ROLE_SUBMITTER),
        5
    );
    assert_eq!(client.total_granted(&recipient, &asset), 30);
    assert_eq!(client.total_granted(&other, &asset), 5);
}

#[test]
fn revocation_reduces_only_the_original_role_total() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &10, &1);
    client.grant(&admin, &recipient, &asset, &ROLE_VERIFIER, &25, &2);

    assert_eq!(client.revoke(&admin, &2), 25);
    assert_eq!(
        client.total_granted_by_role(&recipient, &asset, &ROLE_SUBMITTER),
        10
    );
    assert_eq!(
        client.total_granted_by_role(&recipient, &asset, &ROLE_VERIFIER),
        0
    );
    assert_eq!(client.total_granted(&recipient, &asset), 10);
    assert_eq!(client.treasury_balance(&asset), 990);
}

#[test]
fn claiming_does_not_change_granted_role_totals() {
    let (_env, client, admin, recipient, asset) = setup();
    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &10, &1);
    client.grant(&admin, &recipient, &asset, &ROLE_VERIFIER, &25, &2);

    client.claim(&recipient, &asset, &20);

    assert_eq!(
        client.total_granted_by_role(&recipient, &asset, &ROLE_SUBMITTER),
        10
    );
    assert_eq!(
        client.total_granted_by_role(&recipient, &asset, &ROLE_VERIFIER),
        25
    );
    assert_eq!(client.total_granted(&recipient, &asset), 35);
    assert_eq!(client.total_claimed(&recipient, &asset), 20);
    assert_eq!(client.claimable(&recipient, &asset), 15);
}

#[test]
fn successful_grant_emits_recipient_role_amount_and_identity() {
    let (env, client, admin, recipient, asset) = setup();

    client.grant(&admin, &recipient, &asset, &ROLE_SUBMITTER, &10, &1);

    let expected: Vec<(Address, Vec<Val>, Val)> = Vec::from_array(
        &env,
        [(
            client.address.clone(),
            (symbol_short!("grants"), symbol_short!("granted")).into_val(&env),
            (recipient, ROLE_SUBMITTER, 10i128, 1u64).into_val(&env),
        )],
    );
    assert_eq!(env.events().all(), expected);
}
