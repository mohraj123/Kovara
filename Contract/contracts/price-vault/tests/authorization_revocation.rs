//! #1082 CT-011 — address-scoped authorization revocation.
#![cfg(test)]

use kovara_price_vault::{
    Authorization, AuthorizationRevoked, Error, PriceVault, PriceVaultClient,
    DEFAULT_VALIDITY_WINDOW_SECS,
};
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    vec, Address, Env, Event, Symbol, Vec,
};

struct Fixture<'a> {
    env: Env,
    id: Address,
    client: PriceVaultClient<'a>,
    admin: Address,
    alice: Address,
    bob: Address,
    carol: Address,
}

fn sym(env: &Env, s: &str) -> Symbol {
    Symbol::new(env, s)
}

/// Alice: Food + Rent. Bob: every category. Carol: Health.
fn setup<'a>() -> Fixture<'a> {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(PriceVault, ());
    let client = PriceVaultClient::new(&env, &id);
    let admin = Address::generate(&env);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let carol = Address::generate(&env);
    client.initialize(&admin);
    client.set_authorizations(
        &admin,
        &vec![
            &env,
            Authorization {
                submitter: alice.clone(),
                categories: vec![&env, sym(&env, "Food"), sym(&env, "Rent")],
            },
            Authorization {
                submitter: bob.clone(),
                categories: Vec::new(&env),
            },
            Authorization {
                submitter: carol.clone(),
                categories: vec![&env, sym(&env, "Health")],
            },
        ],
    );
    Fixture {
        env,
        id,
        client,
        admin,
        alice,
        bob,
        carol,
    }
}

fn submit(f: &Fixture, who: &Address, category: &str, ts: u64) -> Result<(), Error> {
    match f.client.try_submit(
        who,
        &sym(&f.env, "NG"),
        &sym(&f.env, category),
        &100,
        &ts,
        &DEFAULT_VALIDITY_WINDOW_SECS,
    ) {
        Ok(_) => Ok(()),
        Err(e) => Err(e.unwrap()),
    }
}

#[test]
fn revocation_removes_only_the_named_submitter() {
    let f = setup();
    let before = f.client.get_authorizations();

    f.client.revoke_authorization(&f.admin, &f.alice);

    // Alice is gone and is now refused.
    assert!(!f.client.is_submitter_authorized(&f.alice, &sym(&f.env, "Food")));
    assert_eq!(submit(&f, &f.alice, "Food", 10), Err(Error::SubmitterNotAllowed));

    // Bob's and Carol's grants are untouched, in their original order.
    let after = f.client.get_authorizations();
    assert_eq!(after.len(), 2);
    assert_eq!(after.get(0).unwrap(), before.get(1).unwrap());
    assert_eq!(after.get(1).unwrap(), before.get(2).unwrap());
    submit(&f, &f.bob, "Transport", 11).unwrap();
    submit(&f, &f.carol, "Health", 12).unwrap();
    assert_eq!(submit(&f, &f.carol, "Food", 13), Err(Error::SubmitterNotAllowed));
}

#[test]
fn revocation_emits_a_typed_event() {
    let f = setup();
    f.client.revoke_authorization(&f.admin, &f.alice);

    let expected = AuthorizationRevoked {
        submitter: f.alice.clone(),
        admin: f.admin.clone(),
        categories: vec![&f.env, sym(&f.env, "Food"), sym(&f.env, "Rent")],
    };
    assert_eq!(f.env.events().all(), [expected.to_xdr(&f.env, &f.id)]);
}

#[test]
fn unauthorized_callers_are_refused_and_nothing_changes() {
    let f = setup();
    let before = f.client.get_authorizations();
    let stranger = Address::generate(&f.env);

    // Neither an outsider nor a granted submitter may revoke.
    for caller in [&stranger, &f.bob] {
        let err = f
            .client
            .try_revoke_authorization(caller, &f.alice)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::Unauthorized);
        assert!(f.env.events().all().events().is_empty());
        assert_eq!(f.client.get_authorizations(), before);
    }
    submit(&f, &f.alice, "Food", 10).unwrap();
}

#[test]
fn an_uninitialised_vault_refuses_revocation() {
    let env = Env::default();
    env.mock_all_auths();
    let client = PriceVaultClient::new(&env, &env.register(PriceVault, ()));
    let anyone = Address::generate(&env);
    let err = client
        .try_revoke_authorization(&anyone, &anyone)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::Unauthorized);
}

#[test]
fn revoking_an_unknown_submitter_is_refused() {
    let f = setup();
    let before = f.client.get_authorizations();
    let nobody = Address::generate(&f.env);

    let err = f
        .client
        .try_revoke_authorization(&f.admin, &nobody)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::AuthorizationNotFound);
    assert_eq!(f.client.get_authorizations(), before);

    // Revoking twice: the second call finds nothing.
    f.client.revoke_authorization(&f.admin, &f.alice);
    let err = f
        .client
        .try_revoke_authorization(&f.admin, &f.alice)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::AuthorizationNotFound);
}

#[test]
fn revoking_the_last_grant_cannot_open_the_vault() {
    let f = setup();
    f.client.revoke_authorization(&f.admin, &f.alice);
    f.client.revoke_authorization(&f.admin, &f.bob);

    // An empty policy means "unrestricted", so removing Carol's grant would
    // let every address submit. That is refused.
    let err = f
        .client
        .try_revoke_authorization(&f.admin, &f.carol)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::LastAuthorization);
    assert_eq!(f.client.get_authorizations().len(), 1);
    let outsider = Address::generate(&f.env);
    assert_eq!(submit(&f, &outsider, "Food", 10), Err(Error::SubmitterNotAllowed));
}

#[test]
fn duplicate_entries_for_one_address_are_all_removed() {
    let f = setup();
    let mut policy = f.client.get_authorizations();
    policy.push_back(Authorization {
        submitter: f.alice.clone(),
        categories: Vec::new(&f.env),
    });
    f.client.set_authorizations(&f.admin, &policy);

    f.client.revoke_authorization(&f.admin, &f.alice);

    // No stale second entry can keep (or widen) Alice's access.
    for entry in f.client.get_authorizations().iter() {
        assert_ne!(entry.submitter, f.alice);
    }
    assert_eq!(submit(&f, &f.alice, "Transport", 10), Err(Error::SubmitterNotAllowed));
}
