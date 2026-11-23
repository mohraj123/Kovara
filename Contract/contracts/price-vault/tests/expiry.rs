#![cfg(test)]

use kovara_price_vault::{PriceVault, PriceVaultClient, SubmissionStatus};
use soroban_sdk::{testutils::Address as _, Address, Env, Symbol};

#[test]
fn expiry_view_distinguishes_fresh_expired_and_absent_submissions() {
    let env = Env::default();
    let contract_id = env.register(PriceVault, ());
    let client = PriceVaultClient::new(&env, &contract_id);
    let submitter = Address::generate(&env);
    let country = Symbol::new(&env, "NG");
    let category = Symbol::new(&env, "Food");
    let valid_from = 1_000_u64;
    let valid_until = 1_100_u64;

    env.mock_all_auths();
    client
        .submit(
            &submitter,
            &country,
            &category,
            &100_i128,
            &valid_from,
            &100_u64,
        )
        .unwrap();

    let fresh = client
        .get_expiry_status(&country, &category, &valid_from, &1_099_u64)
        .unwrap();
    assert_eq!(fresh.status, SubmissionStatus::Pending);
    assert_eq!(fresh.valid_until, valid_until);
    assert!(fresh.is_fresh);
    assert!(!fresh.is_expired);

    let expired = client
        .get_expiry_status(&country, &category, &valid_from, &valid_until)
        .unwrap();
    assert_eq!(expired.status, SubmissionStatus::Pending);
    assert!(!expired.is_fresh);
    assert!(expired.is_expired);

    assert!(client
        .get_expiry_status(&country, &category, &9_999_u64, &valid_until)
        .is_none());
}
