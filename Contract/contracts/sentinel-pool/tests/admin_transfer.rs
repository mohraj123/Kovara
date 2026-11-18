use kovara_sentinel_pool::{Error, SentinelPool, SentinelPoolClient};
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup(env: &Env) -> (SentinelPoolClient<'_>, Address) {
    env.mock_all_auths();
    let client = SentinelPoolClient::new(env, &env.register(SentinelPool, ()));
    let admin = Address::generate(env);
    let governance = Address::generate(env);
    client.initialize(&admin, &governance, &100, &10, &2);
    (client, admin)
}

#[test]
fn proposal_does_not_change_admin_until_accepted() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    let next = Address::generate(&env);

    client.propose_admin(&admin, &next);
    assert_eq!(client.pending_admin(), Some(next.clone()));

    client.accept_admin(&next);
    assert_eq!(client.pending_admin(), None);

    // The old admin can no longer act; the new one can.
    let other = Address::generate(&env);
    assert_eq!(client.try_propose_admin(&admin, &other), Err(Ok(Error::Unauthorized)));
    client.propose_admin(&next, &other);
}

#[test]
fn new_proposal_replaces_previous_one() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    let first = Address::generate(&env);
    let second = Address::generate(&env);

    client.propose_admin(&admin, &first);
    client.propose_admin(&admin, &second);

    assert_eq!(client.try_accept_admin(&first), Err(Ok(Error::Unauthorized)));
    client.accept_admin(&second);
}

#[test]
fn unauthorized_acceptance_is_rejected() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    let next = Address::generate(&env);
    let stranger = Address::generate(&env);

    assert_eq!(client.try_accept_admin(&next), Err(Ok(Error::Unauthorized)));

    client.propose_admin(&admin, &next);
    assert_eq!(client.try_accept_admin(&stranger), Err(Ok(Error::Unauthorized)));
    assert_eq!(client.pending_admin(), Some(next));
}
