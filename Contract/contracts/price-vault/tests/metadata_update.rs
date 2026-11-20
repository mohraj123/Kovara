#![cfg(test)]

use kovara_price_vault::{Error, PriceVault, PriceVaultClient};
use soroban_sdk::{testutils::Address as _, Address, Env, Symbol};

#[test]
fn admin_can_correct_submitter_without_changing_key_or_price() {
    let env = Env::default();
    let contract_id = env.register(PriceVault, ());
    let client = PriceVaultClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let original_submitter = Address::generate(&env);
    let corrected_submitter = Address::generate(&env);
    let country = Symbol::new(&env, "NG");
    let category = Symbol::new(&env, "Food");
    let valid_from = 1_000_u64;

    env.mock_all_auths();
    client.configure_admin(&admin).unwrap();
    client
        .submit(
            &original_submitter,
            &country,
            &category,
            &123_i128,
            &valid_from,
            &100_u64,
        )
        .unwrap();

    client
        .update_submitter(
            &admin,
            &country,
            &category,
            &valid_from,
            &corrected_submitter,
        )
        .unwrap();

    let updated = client
        .get(&country, &category, &valid_from)
        .expect("record remains under its original key");
    assert_eq!(updated.submitter, corrected_submitter);
    assert_eq!(updated.country_iso, country);
    assert_eq!(updated.category, category);
    assert_eq!(updated.valid_from, valid_from);
    assert_eq!(updated.value, 123);
    assert_eq!(
        client
            .get_submitter_history(&corrected_submitter, &0, &10)
            .unwrap()
            .submissions
            .len(),
        1
    );
    assert!(client
        .get_submitter_history(&original_submitter, &0, &10)
        .unwrap()
        .submissions
        .is_empty());
}

#[test]
fn unauthorized_metadata_update_leaves_record_unchanged() {
    let env = Env::default();
    let contract_id = env.register(PriceVault, ());
    let client = PriceVaultClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let outsider = Address::generate(&env);
    let original_submitter = Address::generate(&env);
    let replacement_submitter = Address::generate(&env);
    let country = Symbol::new(&env, "KE");
    let category = Symbol::new(&env, "Rent");
    let valid_from = 2_000_u64;

    env.mock_all_auths();
    client.configure_admin(&admin).unwrap();
    client
        .submit(
            &original_submitter,
            &country,
            &category,
            &456_i128,
            &valid_from,
            &100_u64,
        )
        .unwrap();

    assert_eq!(
        client
            .try_update_submitter(
                &outsider,
                &country,
                &category,
                &valid_from,
                &replacement_submitter,
            )
            .unwrap(),
        Err(Error::Unauthorized)
    );

    let unchanged = client.get(&country, &category, &valid_from).unwrap();
    assert_eq!(unchanged.submitter, original_submitter);
    assert_eq!(unchanged.country_iso, country);
    assert_eq!(unchanged.category, category);
    assert_eq!(unchanged.valid_from, valid_from);
    assert_eq!(unchanged.value, 456);
}
