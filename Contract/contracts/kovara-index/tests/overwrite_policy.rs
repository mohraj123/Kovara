//! CT-044 — overwrite policy for `KovaraIndex`.
//!
//! A published `(country, date)` value is immutable: both publication paths
//! are write-once, and replacing a value is only possible through the
//! explicitly configured correction authority.

use kovara_index::{Error, KovaraIndex, KovaraIndexClient};
use soroban_sdk::{testutils::Address as _, Address, Env, Symbol};

fn setup(env: &Env) -> (KovaraIndexClient<'_>, Address, Address) {
    env.mock_all_auths();
    let contract_id = env.register(KovaraIndex, ());
    (
        KovaraIndexClient::new(env, &contract_id),
        Address::generate(env), // ordinary updater
        Address::generate(env), // correction authority
    )
}

#[test]
fn first_write_is_accepted_and_stored() {
    let env = Env::default();
    let (client, updater, _) = setup(&env);
    let country = Symbol::new(&env, "NG");

    assert_eq!(
        client.try_set_daily_index(&updater, &country, &1, &10_000),
        Ok(Ok(()))
    );
    assert_eq!(client.get_daily_index(&country, &1), Some(10_000));

    // A different date is a different key — still a first write.
    assert_eq!(
        client
            .try_set_daily_index_windowed(&updater, &country, &2, &10_100, &1_000, &2_000, &1_500,),
        Ok(Ok(()))
    );
    assert_eq!(client.get_daily_index(&country, &2), Some(10_100));
    assert_eq!(client.get_daily_window(&country, &2), Some((1_000, 2_000)));

    // Countries are independent.
    let other = Symbol::new(&env, "GH");
    assert_eq!(
        client.try_set_daily_index(&updater, &other, &1, &9_000),
        Ok(Ok(()))
    );
    assert_eq!(client.get_daily_index(&other, &1), Some(9_000));
}

#[test]
fn duplicate_writes_are_refused_without_changing_state() {
    let env = Env::default();
    let (client, updater, _) = setup(&env);
    let country = Symbol::new(&env, "NG");

    client.set_daily_index(&updater, &country, &1, &10_000);

    // Replayed identical write.
    assert_eq!(
        client.try_set_daily_index(&updater, &country, &1, &10_000),
        Err(Ok(Error::DuplicateWrite))
    );
    // A different value under the same key is still a duplicate.
    assert_eq!(
        client.try_set_daily_index(&updater, &country, &1, &11_000),
        Err(Ok(Error::DuplicateWrite))
    );
    // Changing the signer does not bypass the guard.
    let other_updater = Address::generate(&env);
    assert_eq!(
        client.try_set_daily_index(&other_updater, &country, &1, &12_000),
        Err(Ok(Error::DuplicateWrite))
    );
    // Nor does using the windowed publication path.
    assert_eq!(
        client
            .try_set_daily_index_windowed(&updater, &country, &1, &13_000, &1_000, &2_000, &1_500,),
        Err(Ok(Error::DuplicateWrite))
    );

    // Every refusal left the original value and its (absent) window intact.
    assert_eq!(client.get_daily_index(&country, &1), Some(10_000));
    assert_eq!(client.get_daily_window(&country, &1), None);
}

#[test]
fn a_windowed_publication_is_also_write_once() {
    let env = Env::default();
    let (client, updater, _) = setup(&env);
    let country = Symbol::new(&env, "NG");

    client.set_daily_index_windowed(&updater, &country, &5, &10_000, &1_000, &2_000, &1_500);

    // Same windowed call replayed.
    assert_eq!(
        client
            .try_set_daily_index_windowed(&updater, &country, &5, &10_000, &1_000, &2_000, &1_500,),
        Err(Ok(Error::DuplicateWrite))
    );
    // Plain publication cannot overwrite a windowed entry either.
    assert_eq!(
        client.try_set_daily_index(&updater, &country, &5, &11_000),
        Err(Ok(Error::DuplicateWrite))
    );

    assert_eq!(client.get_daily_index(&country, &5), Some(10_000));
    assert_eq!(client.get_daily_window(&country, &5), Some((1_000, 2_000)));
}

#[test]
fn authorized_correction_replaces_only_the_value() {
    let env = Env::default();
    let (client, updater, authority) = setup(&env);
    let country = Symbol::new(&env, "NG");

    assert_eq!(client.try_set_correction_authority(&authority), Ok(Ok(())));
    assert_eq!(client.get_correction_authority(), Some(authority.clone()));

    client.set_daily_index_windowed(&updater, &country, &7, &10_000, &1_000, &2_000, &1_500);

    assert_eq!(
        client.try_correct_daily_index(&authority, &country, &7, &10_050),
        Ok(Ok(()))
    );
    assert_eq!(client.get_daily_index(&country, &7), Some(10_050));
    // A correction fixes the value, not the observation window it came from.
    assert_eq!(client.get_daily_window(&country, &7), Some((1_000, 2_000)));

    // Still write-once for ordinary publications after a correction.
    assert_eq!(
        client.try_set_daily_index(&updater, &country, &7, &20_000),
        Err(Ok(Error::DuplicateWrite))
    );
    // The authority can correct again if a further mistake is found.
    assert_eq!(
        client.try_correct_daily_index(&authority, &country, &7, &10_100),
        Ok(Ok(()))
    );
    assert_eq!(client.get_daily_index(&country, &7), Some(10_100));
}

#[test]
fn unauthorized_and_invalid_corrections_are_rejected() {
    let env = Env::default();
    let (client, updater, authority) = setup(&env);
    let country = Symbol::new(&env, "NG");

    client.set_daily_index(&updater, &country, &1, &10_000);

    // A brand-new contract has no authority: history is immutable by default.
    assert_eq!(
        client.try_correct_daily_index(&authority, &country, &1, &11_000),
        Err(Ok(Error::CorrectionAuthorityNotConfigured))
    );

    assert_eq!(client.try_set_correction_authority(&authority), Ok(Ok(())));

    // A different address cannot correct, even with all auths mocked.
    let intruder = Address::generate(&env);
    assert_eq!(
        client.try_correct_daily_index(&intruder, &country, &1, &12_000),
        Err(Ok(Error::Unauthorized))
    );

    // An unpublished record has nothing to correct.
    assert_eq!(
        client.try_correct_daily_index(&authority, &country, &2, &13_000),
        Err(Ok(Error::NotFound))
    );

    // Zero dates stay invalid on the correction path too.
    assert_eq!(
        client.try_correct_daily_index(&authority, &country, &0, &14_000),
        Err(Ok(Error::InvalidDate))
    );

    // The authority role cannot be reassigned by a retry or a second caller.
    assert_eq!(
        client.try_set_correction_authority(&intruder),
        Err(Ok(Error::AuthorityAlreadyConfigured))
    );
    assert_eq!(client.get_correction_authority(), Some(authority));

    assert_eq!(client.get_daily_index(&country, &1), Some(10_000));
    assert_eq!(client.get_daily_index(&country, &2), None);
}
