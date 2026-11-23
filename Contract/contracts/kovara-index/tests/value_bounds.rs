//! CT-046 — KovaraIndex value bounds.
//!
//! All write paths must reject:
//! * zero values  (`value == 0`)
//! * negative values (`value < 0`)
//! * values above the fixed-point ceiling [`KVI_MAX`] (`value > KVI_MAX`)
//!
//! Valid values on the lower bound (`value == 1`) and on the upper bound
//! (`value == KVI_MAX`) must be accepted.

#![cfg(test)]

use kovara_index::{KovaraIndex, KovaraIndexClient, Error, KVI_MAX};
use soroban_sdk::{testutils::Address as _, Address, Env, Symbol};

fn deploy(env: &Env) -> (KovaraIndexClient<'_>, Address) {
    let id = env.register(KovaraIndex, ());
    (KovaraIndexClient::new(env, &id), Address::generate(env))
}

// ── set_daily_index ──────────────────────────────────────────────────────────

#[test]
fn set_daily_index_rejects_zero() {
    let env = Env::default();
    let (client, updater) = deploy(&env);
    env.mock_all_auths();
    let country = Symbol::new(&env, "NG");

    assert_eq!(
        client.try_set_daily_index(&updater, &country, &1, &0),
        Err(Ok(Error::NonPositiveValue))
    );
    assert_eq!(client.get_daily_index(&country, &1), None);
}

#[test]
fn set_daily_index_rejects_negative() {
    let env = Env::default();
    let (client, updater) = deploy(&env);
    env.mock_all_auths();
    let country = Symbol::new(&env, "NG");

    assert_eq!(
        client.try_set_daily_index(&updater, &country, &1, &-1),
        Err(Ok(Error::NonPositiveValue))
    );
    assert_eq!(client.get_daily_index(&country, &1), None);
}

#[test]
fn set_daily_index_rejects_above_ceiling() {
    let env = Env::default();
    let (client, updater) = deploy(&env);
    env.mock_all_auths();
    let country = Symbol::new(&env, "NG");
    let over = KVI_MAX + 1;

    assert_eq!(
        client.try_set_daily_index(&updater, &country, &1, &over),
        Err(Ok(Error::IndexValueTooHigh))
    );
    assert_eq!(client.get_daily_index(&country, &1), None);
}

#[test]
fn set_daily_index_accepts_lower_bound() {
    let env = Env::default();
    let (client, updater) = deploy(&env);
    env.mock_all_auths();
    let country = Symbol::new(&env, "NG");

    client.set_daily_index(&updater, &country, &1, &1);
    assert_eq!(client.get_daily_index(&country, &1), Some(1));
}

#[test]
fn set_daily_index_accepts_upper_bound() {
    let env = Env::default();
    let (client, updater) = deploy(&env);
    env.mock_all_auths();
    let country = Symbol::new(&env, "NG");

    client.set_daily_index(&updater, &country, &1, &KVI_MAX);
    assert_eq!(client.get_daily_index(&country, &1), Some(KVI_MAX));
}

// ── set_daily_index_windowed ─────────────────────────────────────────────────

#[test]
fn windowed_rejects_zero() {
    let env = Env::default();
    let (client, updater) = deploy(&env);
    env.mock_all_auths();
    let country = Symbol::new(&env, "NG");

    assert_eq!(
        client.try_set_daily_index_windowed(&updater, &country, &1, &0, &1_000, &2_000, &1_500),
        Err(Ok(Error::NonPositiveValue))
    );
    assert_eq!(client.get_daily_index(&country, &1), None);
}

#[test]
fn windowed_rejects_negative() {
    let env = Env::default();
    let (client, updater) = deploy(&env);
    env.mock_all_auths();
    let country = Symbol::new(&env, "NG");

    assert_eq!(
        client.try_set_daily_index_windowed(&updater, &country, &1, &-1, &1_000, &2_000, &1_500),
        Err(Ok(Error::NonPositiveValue))
    );
    assert_eq!(client.get_daily_index(&country, &1), None);
}

#[test]
fn windowed_rejects_above_ceiling() {
    let env = Env::default();
    let (client, updater) = deploy(&env);
    env.mock_all_auths();
    let country = Symbol::new(&env, "NG");
    let over = KVI_MAX + 1;

    assert_eq!(
        client.try_set_daily_index_windowed(&updater, &country, &1, &over, &1_000, &2_000, &1_500),
        Err(Ok(Error::IndexValueTooHigh))
    );
    assert_eq!(client.get_daily_index(&country, &1), None);
}

#[test]
fn windowed_accepts_lower_bound() {
    let env = Env::default();
    let (client, updater) = deploy(&env);
    env.mock_all_auths();
    let country = Symbol::new(&env, "NG");

    client.set_daily_index_windowed(&updater, &country, &1, &1, &1_000, &2_000, &1_500);
    assert_eq!(client.get_daily_index(&country, &1), Some(1));
}

#[test]
fn windowed_accepts_upper_bound() {
    let env = Env::default();
    let (client, updater) = deploy(&env);
    env.mock_all_auths();
    let country = Symbol::new(&env, "NG");

    client.set_daily_index_windowed(&updater, &country, &1, &KVI_MAX, &1_000, &2_000, &1_500);
    assert_eq!(client.get_daily_index(&country, &1), Some(KVI_MAX));
}
