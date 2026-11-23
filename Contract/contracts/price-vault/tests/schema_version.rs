#![cfg(test)]

use kovara_price_vault::{PriceVault, PriceVaultClient, SCHEMA_VERSION};
use soroban_sdk::Env;

#[test]
fn schema_version_is_public_and_requires_no_authorization() {
    let env = Env::default();
    let contract_id = env.register(PriceVault, ());
    let client = PriceVaultClient::new(&env, &contract_id);

    assert_eq!(client.schema_version(), SCHEMA_VERSION);
}
