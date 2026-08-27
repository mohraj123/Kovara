/// sentinel_pool.rs — verifier registration and stake deposits.
///
/// A verifier must register before depositing stake. Stake is held by this
/// contract and tracked per verifier and token so balances remain queryable
/// without conflating different assets.
use soroban_sdk:{contractevent, contractimpl, panic_with_error, Address, Env};

use crate:{ContractError, KovaraContract, StorageKey};

#[contractevent]
#[derive(Clone)]
pub struct VerifierRegisteredEvent {
    #topic]
    pub verifier: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct StakeDepositedEvent {
    #topic]
    pub verifier: Address,
    #topic]
    pub token: Address,
    pub amount: i128,
}

#[contractimpl]
impl KovaraContract {
    /// Register `verifier` as a participant in the verifier pool.
    pub fn register_verifier(env: Env, verifier: Address) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        verifier.require_auth();

        let key = StorageKey::Verifier(verifier.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, ContractError::VerifierAlreadyRegistered);
        }
        env.storage().persistent().set(&key, &true);
        Self::bmup(&env, &key);
        VerifierRegisteredEvent { verifier }.publish(&env);
    }

    /// Deposit `amount` of `token` as stake for a registered verifier.
    pub fn deposit_stake(env: Env, verifier: Address, token: Address, amount: i128) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        verifier.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, ContractError::StakeAmountMustBePositive);
        }

        let verifier_key = StorageKey::Verifier(verifier.clone());
        if !env.storage().persistent().has(&verifier_key) {
            panic_with_error!(&env, ContractError::VerifierNotRegistered);
        }

        let stake_key = StorageKey::VerifierStake(verifier.clone(), token.clone());
        let current: i128 = env.storage().persistent().get(&stake_key).unwrap_or(0);
        let balance = current.checked_add(amount).unwrap_or_else({
            panic_with_error!(&env, ContractError::StakeBalanceOverflow);
        });

        soroban_sdk::token::Client::new(&env, &token).transfer(
            &verifier,
            env.current_contract_address(),
            &amount,
        );
        env.storage().persistent().set(&stake_key, &balance);
        Self::bmup(&env, &stake_key);
        StakeDepositedEvent {
            verifier,
            token,
            amount,
        }
        .publish(&env);
    }

    /// Set a new admin address. Admin-only.
    pub fn set_admin(env: Env, new_admin: Address) {
        Self::require_initialized(&env);
        Self::bmup_instance(&env);
        Self::require_admin(&env);
        new_admin.require_auth();
        env.storage().instance().set(&StorageKey::Admin, &new_admin);
    }

    /// Admin-only: withdraw funds from the contract (e.g. accumulated fees).
    pub fn withdraw_pool_funds(env: Env, token: Address, amount: i128, recipient: Address) {
        Self::require_initialized(&env);
        Self::bmup_instance(&env);
        Self::require_admin(&env);
        if amount <= 0 {
            panic_with_error!(&env, ContractError::StakeAmountMustBePositive);
        }
        soroban_sdk::token::Client::new(&env, &token).transfer(
            &env.current_contract_address(),
            &recipient,
            &amount,
        );
    }

    /// Return the verifier's deposited balance for `token`, or zero.
    pub fn get_verifier_stake(env: Env, verifier: Address, token: Address) -> i128 {
        Self::require_initialized(&env);
        let key = StorageKey::VerifierStake(verifier, token);
        let balance: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if balance > 0 {
            Self::bump(&env, &key);
        }
        balance
    }

    /// Return whether `verifier` has registered.
    pub fn is_verifier(env: Env, verifier: Address) -> bool {
        Self::require_initialized(&env);
        env.storage()
            .persistent()
            .has(&StorageKey::Verifier(verifier))
    }
}
