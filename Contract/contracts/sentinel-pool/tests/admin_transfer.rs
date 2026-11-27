use kovara_sentinel_pool::{Error, SentinelPool, SentinelPoolClient};
use soroban_sdk::{testutils::{Address as _, Events as _}, Address, Env};

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


#[test]
fn transfer_admin_is_a_two_step_rotation_with_auditable_events() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    let nominee = Address::generate(&env);
    let outsider = Address::generate(&env);

    let initial_events = env.events().all().events().len();
    // Only the stored admin can initiate. A rejected call emits no event.
    assert_eq!(
        client.try_transfer_admin(&outsider, &nominee),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(client.pending_admin(), None);
    assert_eq!(env.events().all().events().len(), initial_events);

    client.transfer_admin(&admin, &nominee);
    assert_eq!(client.pending_admin(), Some(nominee.clone()));
    assert_eq!(env.events().all().events().len(), initial_events + 1);

    // Merely being nominated grants no governance configuration rights.
    assert_eq!(
        client.try_set_threshold(&nominee, &3),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        client.try_accept_admin(&outsider),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(env.events().all().events().len(), initial_events + 1);

    client.accept_admin(&nominee);
    assert_eq!(client.pending_admin(), None);
    assert_eq!(env.events().all().events().len(), initial_events + 2);

    // The original admin's permissions are revoked immediately.
    assert_eq!(
        client.try_set_threshold(&admin, &3),
        Err(Ok(Error::Unauthorized))
    );
    client.set_threshold(&nominee, &3);
    assert_eq!(client.threshold(), 3);
    assert_eq!(
        client.try_accept_admin(&nominee),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn a_replaced_admin_nominee_cannot_accept_and_emits_no_completion_event() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    let old_nominee = Address::generate(&env);
    let new_nominee = Address::generate(&env);

    let initial_events = env.events().all().events().len();
    // Keep the existing propose_admin entrypoint backward-compatible.
    client.propose_admin(&admin, &old_nominee);
    client.transfer_admin(&admin, &new_nominee);
    assert_eq!(client.pending_admin(), Some(new_nominee.clone()));
    assert_eq!(env.events().all().events().len(), initial_events + 2);

    assert_eq!(
        client.try_accept_admin(&old_nominee),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(env.events().all().events().len(), initial_events + 2);

    client.accept_admin(&new_nominee);
    assert_eq!(client.pending_admin(), None);
    assert_eq!(env.events().all().events().len(), initial_events + 3);
}
