/// sentinel_pool.rs — verifier registration and stake deposits.
///
/// A verifier must register before depositing stake. Stake is held by this
/// contract and tracked per verifier and token so balances remain queryable
/// without conflating different assets.
use soroban_sdk::{contractevent, contractimpl, panic_with_error, Address, Env, Symbol};

use crate::{ContractError, KovaraContract, StorageKey, ADMIN};

// ── Types ─────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resolution {
    Approved,
    Rejected,
    Tie,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    Approve,
    Reject,
    Abstain,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoundStatus {
    Open,
    Finalized(Resolution),
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct VoteRound {
    pub end_ledger: u32,
    pub votes_approve: u32,
    pub votes_reject: u32,
    pub status: RoundStatus,
}

// ── Events ────────────────────────────────────────────────────────────────────

#[contractevent]
#[derive(Clone)]
pub struct VerifierRegisteredEvent {
    #[topic]
    pub verifier: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct StakeDepositedEvent {
    #[topic]
    pub verifier: Address,
    #[topic]
    pub token: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct StakeWithdrawnEvent {
    #[topic]
    pub verifier: Address,
    #[topic]
    pub token: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct RoundFinalizedEvent {
    #[topic]
    pub submission_id: u64,
    pub resolution: Resolution,
}

// ── Implementation ────────────────────────────────────────────────────────────

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
        Self::bump(&env, &key);
        VerifierRegisteredEvent { verifier }.publish(&env);
    }

    /// Deposit `amount` of `token` as stake for a registered verifier.
    ///
    /// Uses `checked_add` so that an overflow produces `StakeBalanceOverflow`
    /// instead of wrapping or aborting with a generic host trap.
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
        let current: i128 = env
            .storage()
            .persistent()
            .get(&stake_key)
            .unwrap_or(0i128);

        // CT-022: use checked_add so overflow produces a named contract error
        // rather than a generic host trap or (in debug builds) a panic without
        // a meaningful on-chain error code.
        let new_balance = current
            .checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::StakeBalanceOverflow));

        let minimum_stake = Self::minimum_verifier_stake(&env);
        if new_balance < minimum_stake {
            panic_with_error!(&env, ContractError::InsufficientVerifierStake);
        }

        soroban_sdk::token::Client::new(&env, &token).transfer(
            &verifier,
            &env.current_contract_address(),
            &amount,
        );
        env.storage().persistent().set(&stake_key, &new_balance);
        Self::bump(&env, &stake_key);
        StakeDepositedEvent {
            verifier,
            token,
            amount,
        }
        .publish(&env);
    }

    /// Withdraw `amount` of `token` stake for a registered verifier.
    ///
    /// CT-022: decrements on-chain `VerifierStake` storage before transferring
    /// so the accounting balance stays in sync with the actual token balance.
    /// Uses `checked_sub` so underflow (withdrawal > balance) produces a named
    /// `PoolBalanceUnderflow` error rather than wrapping silently.
    pub fn withdraw_stake(env: Env, verifier: Address, token: Address, amount: i128) {
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
        let current: i128 = env
            .storage()
            .persistent()
            .get(&stake_key)
            .unwrap_or(0i128);

        // CT-022: validate amount <= current before mutating state.
        // checked_sub returns None when current < amount (underflow).
        let new_balance = current
            .checked_sub(amount)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::PoolBalanceUnderflow));

        // Write the decremented balance first (check-effects-interactions).
        env.storage().persistent().set(&stake_key, &new_balance);
        if new_balance > 0 {
            Self::bump(&env, &stake_key);
        }

        soroban_sdk::token::Client::new(&env, &token).transfer(
            &env.current_contract_address(),
            &verifier,
            &amount,
        );
        StakeWithdrawnEvent {
            verifier,
            token,
            amount,
        }
        .publish(&env);
    }

    /// Set a new admin address. Admin-only.
    pub fn set_admin(env: Env, new_admin: Address) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        Self::require_admin(&env);
        new_admin.require_auth();
        // Use the ADMIN symbol constant (same key used by initialize / require_admin),
        // not a non-existent StorageKey::Admin variant.
        env.storage().instance().set(&ADMIN, &new_admin);
    }

    /// Admin-only: withdraw surplus funds from the contract (e.g. accumulated fees).
    ///
    /// CT-022 note: this entry point is for *fee/surplus* funds, not verifier stake.
    /// Verifier stake withdrawals must go through `withdraw_stake` so that the
    /// on-chain `VerifierStake` balance is kept in sync.
    pub fn withdraw_pool_funds(env: Env, token: Address, amount: i128, recipient: Address) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
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

    /// Set the minimum balance required for a verifier's stake in one token.
    /// Existing balances are not modified; the new value applies to future deposits.
    pub fn set_minimum_verifier_stake(env: Env, minimum_stake: i128) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        Self::require_admin(&env);
        if minimum_stake <= 0 {
            panic_with_error!(&env, ContractError::MinimumVerifierStakeMustBePositive);
        }
        env.storage()
            .instance()
            .set(&crate::MIN_VERIFIER_STAKE, &minimum_stake);
    }

    /// Return the configured minimum verifier stake.
    pub fn get_minimum_verifier_stake(env: Env) -> i128 {
        Self::require_initialized(&env);
        Self::minimum_verifier_stake(&env)
    }

    /// Return whether `verifier` has registered.
    pub fn is_verifier(env: Env, verifier: Address) -> bool {
        Self::require_initialized(&env);
        env.storage()
            .persistent()
            .has(&StorageKey::Verifier(verifier))
    }

    pub(crate) fn minimum_verifier_stake(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&crate::MIN_VERIFIER_STAKE)
            .unwrap_or(1)
    }

    // ── Vote round lifecycle ──────────────────────────────────────────────────

    /// Open a new vote round for `submission_id` lasting `duration` ledgers.
    ///
    /// # Panics
    /// - `RoundAlreadyExists` if the round already exists.
    pub fn open_round(env: Env, submission_id: u64, duration: u32) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        Self::require_admin(&env);

        let key = StorageKey::VoteRound(submission_id);
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, ContractError::RoundAlreadyExists);
        }

        let round = VoteRound {
            end_ledger: env.ledger().sequence() + duration,
            votes_approve: 0,
            votes_reject: 0,
            status: RoundStatus::Open,
        };
        env.storage().persistent().set(&key, &round);
        Self::bump(&env, &key);
    }

    /// Cast a vote for `submission_id`.
    ///
    /// # Panics
    /// - `RoundNotFound` if the round does not exist.
    /// - `RoundClosed` if the voting window has passed.
    /// - `AlreadyVoted` if this verifier already voted.
    pub fn vote(env: Env, verifier: Address, submission_id: u64, verdict: Verdict) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        verifier.require_auth();

        let key = StorageKey::VoteRound(submission_id);
        let mut round: VoteRound = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::RoundNotFound));

        if env.ledger().sequence() > round.end_ledger {
            panic_with_error!(&env, ContractError::RoundClosed);
        }

        let voted_key = StorageKey::HasVoted(submission_id, verifier.clone());
        if env.storage().persistent().has(&voted_key) {
            panic_with_error!(&env, ContractError::AlreadyVoted);
        }

        match verdict {
            Verdict::Approve => {
                round.votes_approve = round
                    .votes_approve
                    .checked_add(1)
                    .unwrap_or_else(|| panic_with_error!(&env, ContractError::StakeBalanceOverflow));
            }
            Verdict::Reject => {
                round.votes_reject = round
                    .votes_reject
                    .checked_add(1)
                    .unwrap_or_else(|| panic_with_error!(&env, ContractError::StakeBalanceOverflow));
            }
            Verdict::Abstain => {}
        }

        env.storage().persistent().set(&voted_key, &true);
        Self::bump(&env, &voted_key);
        env.storage().persistent().set(&key, &round);
        Self::bump(&env, &key);
    }

    /// Resolve quorum for a submission and emit one immutable outcome.
    ///
    /// # Panics
    /// - `RoundNotFound` if the round does not exist.
    /// - `RoundStillOpen` if the current ledger is before or equal to the end ledger.
    /// - `RoundAlreadyFinalized` if the round has already been resolved.
    pub fn resolve(env: Env, submission_id: u64) -> Resolution {
        Self::require_initialized(&env);
        Self::bump_instance(&env);

        let key = StorageKey::VoteRound(submission_id);
        let mut round: VoteRound = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::RoundNotFound));

        if let RoundStatus::Finalized(_) = round.status {
            panic_with_error!(&env, ContractError::RoundAlreadyFinalized);
        }

        if env.ledger().sequence() <= round.end_ledger {
            panic_with_error!(&env, ContractError::RoundStillOpen);
        }

        let resolution = if round.votes_approve > round.votes_reject {
            Resolution::Approved
        } else if round.votes_reject > round.votes_approve {
            Resolution::Rejected
        } else {
            Resolution::Tie
        };

        round.status = RoundStatus::Finalized(resolution.clone());
        env.storage().persistent().set(&key, &round);
        Self::bump(&env, &key);

        RoundFinalizedEvent {
            submission_id,
            resolution: resolution.clone(),
        }
        .publish(&env);

        resolution
    }
}
