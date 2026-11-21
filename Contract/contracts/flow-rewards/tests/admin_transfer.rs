use kovara_flow_rewards::{Error, FlowRewards, FlowRewardsClient};
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup(env: &Env) -> (FlowRewardsClient<'_>, Address) {
    env.mock_all_auths();
    let client = FlowRewardsClient::new(env, &env.register(FlowRewards, ()));
    let admin = Address::generate(env);
    client.set_admin(&admin);
    (client, admin)
}

#[test]
fn proposed_admin_takes_over_only_after_accepting() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    let next = Address::generate(&env);
    let third = Address::generate(&env);

    client.propose_admin(&admin, &next);
    assert_eq!(client.admin(), Some(admin.clone()));
    assert_eq!(client.pending_admin(), Some(next.clone()));

    client.accept_admin(&next);
    assert_eq!(client.admin(), Some(next.clone()));
    assert_eq!(client.pending_admin(), None);
    assert_eq!(
        client.try_propose_admin(&admin, &third),
        Err(Ok(Error::Unauthorized))
    );
    client.propose_admin(&next, &third);
}

#[test]
fn only_the_pending_admin_can_accept_and_proposals_can_be_replaced() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    let first = Address::generate(&env);
    let second = Address::generate(&env);
    let stranger = Address::generate(&env);

    client.propose_admin(&admin, &first);
    assert_eq!(
        client.try_accept_admin(&stranger),
        Err(Ok(Error::Unauthorized))
    );

    client.propose_admin(&admin, &second);
    assert_eq!(client.pending_admin(), Some(second.clone()));
    assert_eq!(
        client.try_accept_admin(&first),
        Err(Ok(Error::Unauthorized))
    );
    client.accept_admin(&second);
    assert_eq!(client.admin(), Some(second));
    assert_eq!(client.pending_admin(), None);
}

#[test]
fn configured_admin_cannot_be_replaced_without_acceptance() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    let replacement = Address::generate(&env);

    assert_eq!(
        client.try_set_admin(&replacement),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(client.admin(), Some(admin));
}
