//! Updater authorization, rotation, revision history and admin correction.

use kovara_index::{Error, KovaraIndex, KovaraIndexClient};
use soroban_sdk::{testutils::Address as _, Address, Env, Symbol};

#[test]
fn updater_rotation_revisions_and_admin_correction() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(KovaraIndex, ());
    let client = KovaraIndexClient::new(&env, &id);
    let (admin, u1, u2) = (
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    );
    let ng = Symbol::new(&env, "NG");

    // Updater management needs an admin first; the admin role is one-shot.
    assert_eq!(
        client.try_set_updater(&admin, &u1),
        Err(Ok(Error::AdminNotConfigured))
    );
    client.set_admin(&admin);
    assert_eq!(
        client.try_set_admin(&u1),
        Err(Ok(Error::AdminAlreadyConfigured))
    );
    assert_eq!(
        client.try_set_updater(&u1, &u1),
        Err(Ok(Error::Unauthorized))
    );

    // Only the configured updater may publish.
    client.set_updater(&admin, &u1);
    assert_eq!(client.get_updater(), Some(u1.clone()));
    assert_eq!(
        client.try_set_daily_index(&u2, &ng, &1, &100),
        Err(Ok(Error::Unauthorized))
    );
    client.set_daily_index(&u1, &ng, &1, &100);

    // Rotation: the old updater loses access, the new one gains it.
    client.rotate_updater(&admin, &u2);
    assert_eq!(
        client.try_set_daily_index(&u1, &ng, &2, &200),
        Err(Ok(Error::Unauthorized))
    );
    client.set_daily_index(&u2, &ng, &2, &200);

    // The updater cannot correct; the admin can, and it is logged.
    assert_eq!(
        client.try_admin_correct_daily_index(&u2, &ng, &1, &150),
        Err(Ok(Error::Unauthorized))
    );
    client.admin_correct_daily_index(&admin, &ng, &1, &150);
    assert_eq!(client.get_daily_index(&ng, &1), Some(150));

    // Append-only history with bounds.
    assert_eq!(client.get_revision_count(&ng, &1), 2);
    let first = client.get_revision(&ng, &1, &0).unwrap();
    assert_eq!((first.value, first.updater, first.correction), (100, u1, false));
    let second = client.get_revision(&ng, &1, &1).unwrap();
    assert_eq!((second.value, second.updater, second.correction), (150, admin, true));
    assert_eq!(client.get_revision(&ng, &1, &2), None);
}
