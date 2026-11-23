use kovara_flow_rewards::{Error, FlowRewards, FlowRewardsClient, ROLE_SUBMITTER, ROLE_VERIFIER};
use soroban_sdk::{symbol_short, testutils::Address as _, Address, Env, IntoVal, Symbol, Val, Vec};

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

    let events = env.events().all();
    assert_eq!(events.len(), 1);

    let (topics, data) = &events[0];
    assert_eq!(
        topics,
        &Vec::from_array::<_, 2>(
            &env,
            [
                symbol_short!("grants").into_val(&env),
                symbol_short!("granted").into_val(&env),
            ],
        )
    );

    let payload: (Address, Symbol, i128, u64) = data.clone().into_val(&env);
    assert_eq!(payload, (recipient, ROLE_SUBMITTER, 10, 1));
}
