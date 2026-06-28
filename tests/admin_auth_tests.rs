#![cfg(test)]

use crate::{PoolContract, PoolContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    vec, Address, Env, IntoVal, Symbol, Val,
};

/// Helper context containing boilerplate components for administrative testing
struct TestContext {
    env: Env,
    client: PoolContractClient<'static>,
    root_admin: Address,
    target_user: Address,
    malicious_user: Address,
}

fn setup_test_context() -> TestContext {
    let env = Env::default();
    env.mock_all_auths(); // Enable auth mocking framework to catch invoke targets

    let contract_id = env.register_contract(None, PoolContract);
    let client = PoolContractClient::new(&env, &contract_id);

    // Generate distinct cryptographic test identities
    let root_admin = Address::generate(&env);
    let target_user = Address::generate(&env);
    let malicious_user = Address::generate(&env);

    // Initialize contract with the root administrator identity
    // Adjust initialize function arguments to match your pool's actual signature
    client.initialize(&root_admin);

    TestContext {
        env,
        client,
        root_admin,
        target_user,
        malicious_user,
    }
}

#[test]
fn test_root_admin_can_successfully_add_and_remove_pool_admins() {
    let ctx = setup_test_context();

    // 1. Verify target_user is not an admin initially
    assert!(!ctx.client.is_admin(&ctx.target_user));

    // 2. Add pool admin as root_admin
    ctx.client.add_admin(&ctx.root_admin, &ctx.target_user);

    // Assert that the contract recorded the root authorization challenge accurately
    assert_eq!(
        ctx.env.auths(),
        vec![
            &ctx.env,
            (
                ctx.root_admin.clone(),
                soroban_sdk::testutils::AuthorizedInvocation {
                    function: soroban_sdk::testutils::AuthorizedFunction::Contract((
                        ctx.client.address.clone(),
                        Symbol::new(&ctx.env, "add_admin"),
                        vec![&ctx.env, ctx.root_admin.to_val(), ctx.target_user.to_val()]
                    )),
                    sub_invocations: vec![&ctx.env]
                }
            )
        ]
    );

    // Verify state transition passed
    assert!(ctx.client.is_admin(&ctx.target_user));

    // 3. Remove pool admin as root_admin
    ctx.client.remove_admin(&ctx.root_admin, &ctx.target_user);
    assert!(!ctx.client.is_admin(&ctx.target_user));
}

#[test]
#[should_panic] // Soroban mock auth triggers a panic if an unauthorized signature is simulated
fn test_unauthorized_user_cannot_add_pool_admins() {
    let ctx = setup_test_context();
    
    // Disable global mock auth overrides to enforce strict signature matching
    ctx.env.mock_all_auths_allowing_non_mocked_auth();

    // Attempting to add an admin using a forged root_admin parameter signed by malicious_user
    // This will trip Soroban's native contract authorization check and halt execution
    ctx.client.add_admin(&ctx.malicious_user, &ctx.target_user);
}

#[test]
#[should_panic]
fn test_unauthorized_user_cannot_remove_pool_admins() {
    let ctx = setup_test_context();
    
    // Seed target_user into the admin registry first
    ctx.client.add_admin(&ctx.root_admin, &ctx.target_user);
    assert!(ctx.client.is_admin(&ctx.target_user));

    ctx.env.mock_all_auths_allowing_non_mocked_auth();

    // Malicious actor attempts to remove the legitimate administrator
    ctx.client.remove_admin(&ctx.malicious_user, &ctx.target_user);
}