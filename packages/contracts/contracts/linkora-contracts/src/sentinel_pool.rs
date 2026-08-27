/// sentinel_pool.rs — verifier registration and stake deposits.
///
/// A verifier must register before depositing stake. Stake is held by this
/// contract and tracked per verifier and token so balances remain queryable
/// without conflating different assets.
use soroban_sdk::{contractevent, contractimpl, panic_with_error, Address, Env};

use crate::{ContractError, KovaraContract, StorageKey};

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
        let minimum_stake = Self::minimum_verifier_stake(&env);
        let new_balance = current.checked_add(amount).unwrap_or_else(|| {
            panic_with_error!(&env, ContractError::StakeBalanceOverflow);
        });
        if new_balance < minimum_stake {
            panic_with_error!(&env, ContractError::InsufficientVerifierStake);
        }
        let balance = new_balance;

        soroban_sdk::token::Client::new(&env, &token).transfer(
            &verifier,
            env.current_contract_address(),
            &amount,
        );
        env.storage().persistent().set(&stake_key, &balance);
        Self::bump(&env, &stake_key);
        StakeDepositedEvent {
            verifier,
            token,
            amount,
pub struct RoundFinalizedEvent {
    #[topic]
    pub submission_id: u64,
    pub resolution: Resolution,
}

#[contractevent]
#[derive(Clone)]
pub struct RoundOpenedEvent {
    #[topic]
    pub submission_id: u64,
    pub start_ledger: u32,
    pub end_ledger: u32,
}

// ── impl ──────────────────────────────────────────────────────────────────────

#[contractimpl]
impl KovaraContract {
    /// Open a new voting round for a submission.
    /// 
    /// Admin-only. 
    ///
    /// # Panics
    /// - `RoundAlreadyExists` if the round for this submission is already open.
    pub fn open_round(env: Env, submission_id: u64, duration_ledgers: u32) {
        Self::require_initialized(&env);
        Self::bump_instance(&env);
        Self::require_admin(&env);

        let key = StorageKey::VoteRound(submission_id);
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, ContractError::RoundAlreadyExists);
        }

        let start_ledger = env.ledger().sequence();
        let end_ledger = start_ledger + duration_ledgers;

        let round = VoteRound {
            submission_id,
            start_ledger,
            end_ledger,
            status: RoundStatus::Open,
            votes_approve: 0,
            votes_reject: 0,
        };

        env.storage().persistent().set(&key, &round);
        Self::bump(&env, &key);

        RoundOpenedEvent {
            submission_id,
            start_ledger,
            end_ledger,
        }
        .publish(&env);
    }

    /// Cast a verification vote on a submission.
    ///
    /// # Panics
    /// - `RoundNotFound` if the round does not exist.
    /// - `RoundClosed` if the current ledger is past the end ledger.
    /// - `RoundAlreadyFinalized` if the round has already been resolved.
    /// - `AlreadyVoted` if the verifier has already voted.
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

        match round.status {
            RoundStatus::Open => {}
            RoundStatus::Finalized(_) => {
                panic_with_error!(&env, ContractError::RoundAlreadyFinalized);
            }
        }

        if env.ledger().sequence() > round.end_ledger {
            panic_with_error!(&env, ContractError::RoundClosed);
        }

        let voted_key = StorageKey::HasVoted(submission_id, verifier.clone());
        if env.storage().persistent().has(&voted_key) {
            panic_with_error!(&env, ContractError::AlreadyVoted);
        }

        match verdict {
            Verdict::Approve => round.votes_approve += 1,
            Verdict::Reject => round.votes_reject += 1,
        }

        env.storage().persistent().set(&voted_key, &true);
        env.storage().persistent().set(&key, &round);
        Self::bump(&env, &voted_key);
        Self::bump(&env, &key);

        VoteCastEvent {
            submission_id,
            verifier,
            verdict,
        }
        .publish(&env);
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
        env.storage().instance().set(&crate::MIN_VERIFIER_STAKE, &minimum_stake);
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

    fn minimum_verifier_stake(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&crate::MIN_VERIFIER_STAKE)
            .unwrap_or(1)
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
