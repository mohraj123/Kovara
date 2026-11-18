#![no_std]
//! `SentinelPool` — manages verifier staking, governance thresholds, withdrawals,
//! and fraud slashing for the sentinel set.
//!
//! # One aggregate, maintained not recomputed
//!
//! `total_stake` is a stored running total, updated by `stake`, `withdraw` and
//! `slash` with `checked_add` / `checked_sub`. Every mutation writes the
//! per-address balance and the aggregate in the same call, and checks the
//! arithmetic **before** either write, so the aggregate can never disagree with
//! the balances it summarizes and an arithmetic failure leaves both untouched.
//!
//! # Emergency pause
//!
//! `pause` stops value movement without freezing the pool's configuration.
//! [`SentinelPool::pause`] carries the full matrix; the short version is that
//! `stake`, `withdraw` and `slash` refuse with [`Error::PoolPaused`], while the
//! pause control itself, the configuration setters and every read keep working —
//! because the controls you need during an incident are exactly the ones that
//! must not be frozen.
//!
//! # Leaving the set is a lifecycle event
//!
//! A sentinel with a non-zero balance cannot withdraw down to zero: it would
//! silently de-register the address with nothing recording why. `deregister` is
//! that record. After deregistration the withdrawal lock still applies, and a
//! further challenge period must elapse before the balance can leave the pool —
//! so a sentinel cannot deregister and immediately withdraw to escape a slash
//! review that is still running.
//!
//! `is_eligible` is the query that ties these together: it answers "would this
//! address count as an active sentinel at ledger N?" in one read, without the
//! caller re-deriving the floor, the lock and the deregistration state by hand.
//! # Slashing is a governed, reversible process, not a one-way write
//!
//! A slash takes a sentinel's stake immediately, but it is the start of a
//! process rather than the end of one:
//!
//! ```text
//!  slash ──► Pending ──appeal──► Pending ──resolve──► Upheld | Reversed
//!              │                  │
//!              └──────────────────┘
//!         appeal only until `appeal_deadline`
//! ```
//!
//! * **Evidence.** [`SlashEvidence`] carries a proof reference, a URI and a
//!   content hash. They are stored on the record and republished on
//!   [`SlashedEvent`], so an off-chain audit consumer never has to infer *why*
//!   a balance changed.
//! * **A bounded appeal window.** A slash records `appeal_deadline =
//!   slashed_at + appeal_window`. An appeal after that ledger is refused with
//!   [`Error::AppealWindowClosed`] — the window is what stops an appeal from
//!   being raised at an arbitrary point in the future to relitigate a settled
//!   matter.
//! * **Exactly one resolution.** [`SentinelPool::resolve_slash`] upholds or
//!   reverses a slash once. A reversal restores the slashed amount with
//!   `checked_add`; a second resolution is [`Error::AlreadyResolved`].
//!
//! # Governance authorization
//!
//! Every slash operation — applying, appealing, resolving — requires the
//! configured governance address, resolved from storage by [`SentinelPool::require_governance`].
//! A missing configuration is [`Error::GovernanceNotConfigured`], not a
//! fall-through to the caller: an ungoverned pool cannot be slashed at all,
//! rather than being governed by whoever happened to sign the transaction.
//! Refused calls leave the stake and the replay state untouched.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Bytes, Env, Map,
    String, Symbol,
};

/// Default appeal window: seven days expressed in ledger sequence numbers.
///
/// Long enough for a sentinel to gather evidence and for governance to convene;
/// short enough that a dispute is resolved while the stake still means
/// something.
pub const DEFAULT_APPEAL_WINDOW_LEDGERS: u64 = 604_800;

/// Upper bound on the appeal window, in ledger sequence numbers.
///
/// The deadline is `slashed_at + appeal_window` and is stored in a `u64`. An
/// unrepresentable window would not be a long appeal period — it would be an
/// appeal period that cannot be expressed at all, so the boundary would have to
/// be special-cased everywhere. Bounding it keeps the deadline representable for
/// every reachable `slashed_at`.
pub const MAX_APPEAL_WINDOW_LEDGERS: u64 = 6_000_000;
//! # The withdrawal lock is a window, not a counter
//!
//! A sentinel's lock is stored as a single ledger — `staked_at` — and the lock
//! runs until `staked_at + lock_period`. Everything about the lock follows from
//! that one value being an *absolute ledger* rather than a countdown:
//!
//! * **Arithmetic is checked, not saturating.** `unlock_at` is derived with
//!   `checked_add`; an unrepresentable window returns
//!   [`Error::InvalidLockPeriod`] instead of silently pinning itself to
//!   `u64::MAX`, which would be a lock that never expires.
//! * **A top-up does not move the window.** While the lock is still running,
//!   `stake` leaves `staked_at` untouched. A sentinel that keeps topping up
//!   cannot push its own unlock date further out, and — equally important — a
//!   top-up cannot be used to escape a lock that is about to expire by resetting
//!   it. Once the window has elapsed, the next `stake` starts a fresh one.
//!
//! # A slash is identified by a proof, not by a (sentinel, reason) pair
//!
//! Replay protection used to key on `(sentinel, reason)` — a pair of a contract
//! address and a `Symbol`. That key is not unique: two genuinely distinct
//! incidents against the same sentinel can share a reason code, and the second
//! one is then refused as a replay of the first. Conversely a single incident
//! relabelled with a different reason slips through twice.
//!
//! `slash` now takes an explicit `proof_id`, chosen by the caller and required
//! to be globally unique within the pool. A [`SlashProof`] record is stored
//! under it, so "this identifier has been used" is a fact the contract can
//! answer, and an auditor can join a slash back to the evidence that justified
//! it.
//!
//! # Slash amounts are bounded before anything is written
//!
//! `amount` is checked against three bounds in a fixed order — positive, at most
//! the current stake, leaving at least `min_stake` behind — and the balance map
//! is written only after all three pass. Each failure has its own error, so a
//! caller can tell a malformed amount from an unaffordable one.
//! # Initialization is a precondition, not a convention
//!
//! Every state-changing entry point calls `require_initialized` before it
//! touches storage or asks for authorization. An uninitialized pool therefore
//! rejects `stake`, `withdraw`, `set_threshold`, `set_min_stake` and `slash`
//! with [`Error::NotInitialized`] instead of silently behaving like a pool whose
//! `min_stake` is `0` and whose `lock_period` is `0` — a state in which anybody
//! could stake nothing and anybody could be slashed against a stake that does
//! not exist.
//!
//! `initialize` is itself all-or-nothing: every parameter is validated before
//! the first write, so a rejected call leaves `DataKey::Admin` absent and the
//! contract still initializable. See [`SentinelPool::initialize`].
//! # The minimum-stake floor is a registration rule
//!
//! An address with a non-zero stake is a *registered sentinel*, and a registered
//! sentinel is expected to keep at least `min_stake` on deposit for as long as
//! it stays registered. `stake` enforces that on the way in and `withdraw`
//! enforces it on the way out, so the floor holds at every observable balance —
//! including the very first one.
//!
//! The consequence, stated plainly: **a partial withdrawal may take a sentinel
//! down to exactly `min_stake` and no further.** Withdrawing to zero is not
//! available through `withdraw`, because a zero balance would silently
//! de-register the address, and the pool has no separate deregistration step to
//! record why the address stopped being a sentinel. Leaving the set is a
//! lifecycle event, not a side effect of an arithmetic result.
//!
//! # Withdrawal accounting is checked end to end
//!
//! `withdraw` validates `amount > 0`, `amount <= balance` and the resulting
//! remainder in that order, and writes the balance map only once every check has
//! passed. A rejected withdrawal leaves the sentinel's balance byte-for-byte
//! unchanged and emits nothing.
//!
//! # Reads never mutate
//!
//! `balance`, `stake_of` and `total_active_stake` are views. They report
//! storage and ledger state and write nothing, so an indexer can poll them
//! without constructing a transaction or perturbing the pool.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, Map,
    String, Symbol,
};

/// Default challenge period, in ledger sequence numbers: thirty days.
///
/// The gap between deregistering and being able to withdraw the balance. It
/// exists so that a slash under review when a sentinel leaves still has a live
/// stake to act on.
pub const DEFAULT_CHALLENGE_PERIOD_LEDGERS: u64 = 2_592_000;

/// Upper bound on the challenge period, in ledger sequence numbers.
///
/// The deadline is `deregistered_at + challenge_period` and is stored in a
/// `u64`. Bounding the period keeps the deadline representable for every
/// reachable `deregistered_at`; the arithmetic is still checked at use.
pub const MAX_CHALLENGE_PERIOD_LEDGERS: u64 = 20_000_000;
/// Upper bound on the withdrawal lock period, in ledger sequence numbers.
///
/// The lock is `unlock_at = staked_at + lock_period`, and `staked_at` is a
/// ledger sequence number. A lock period large enough to overflow that addition
/// would never elapse, which is a permanent freeze rather than a slow
/// withdrawal. Bounding the parameter keeps every reachable unlock ledger
/// representable, and the arithmetic is still checked at runtime.
/// The lock is expressed as `ledger.sequence()`, which is a `u32`. A lock that
/// cannot elapse is worse than a short one: it would permanently freeze every
/// sentinel's stake with no recovery path. Bounding the parameter at
/// initialization keeps `staked_at + lock_period` inside the `u32` ledger
/// sequence space for every reachable `staked_at`.
pub const MAX_LOCK_PERIOD: u64 = 1_000_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    InvalidStake = 1,
    Unauthorized = 2,
    StakeBelowMinimum = 3,
    LockPeriodActive = 4,
    InvalidThreshold = 5,
    InvalidAmount = 6,
    FraudProofAlreadyUsed = 7,
    InsufficientBalance = 8,
    /// The pool is paused. Append-only discriminant; see the ABI note in
    /// `README.md`.
    PoolPaused = 9,
    /// The challenge period is zero or above [`MAX_CHALLENGE_PERIOD_LEDGERS`].
    InvalidChallengePeriod = 10,
    /// A full exit was attempted by an address that never deregistered.
    NotDeregistered = 11,
    /// The challenge period after deregistration has not elapsed.
    ChallengePeriodActive = 12,
    /// The address is already deregistered.
    AlreadyDeregistered = 13,
    /// No governance address is configured to operate the pause control.
    PauseNotAuthorized = 14,
    /// The caller is not the configured governance address.
    NotGovernance = 9,
    /// No governance address has been configured.
    GovernanceNotConfigured = 10,
    /// The appeal window is zero or above [`MAX_APPEAL_WINDOW_LEDGERS`].
    InvalidAppealWindow = 11,
    /// The appeal arrived at or after the recorded deadline.
    AppealWindowClosed = 12,
    /// The slash has already been resolved.
    AlreadyResolved = 13,
    /// No slash is recorded under the supplied proof reference.
    UnknownProof = 14,
    /// The evidence is missing a proof reference or a URI.
    InvalidEvidence = 15,
    /// `staked_at + lock_period` is not representable as a `u64`. Append-only
    /// discriminant; see the ABI note in `README.md`.
    InvalidLockPeriod = 9,
    /// A slash amount was zero or negative.
    InvalidSlashAmount = 10,
    /// A slash amount exceeded the sentinel's current stake.
    SlashExceedsStake = 11,
    /// A slash was submitted without a proof identifier.
    InvalidProofId = 12,
    /// The pool has not been configured yet. Append-only discriminant; see the
    /// ABI note in `README.md`.
    NotInitialized = 9,
    /// `lock_period` is zero or above [`MAX_LOCK_PERIOD`].
    InvalidLockPeriod = 10,
    /// The governance proposal being accepted is not the current one (#1097).
    StaleProposal = 16,
    /// More sentinels were supplied than the caller's cap allows (#1096).
    TooManySentinels = 17,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    // Existing variants keep their positions: `contracttype` discriminants are
    // the variant index, so inserting here would rename the storage key of every
    // later variant. New keys are appended.
    Admin,
    MinStake,
    LockPeriod,
    Threshold,
    Stakes,
    StakedAt,
    /// `proof_ref` -> [`SlashRecord`].
    /// `proof_id` -> [`SlashProof`].
    ///
    /// The key is the caller's unique identifier, not a `(sentinel, reason)`
    /// pair; see the module docs for why the pair was not unique enough.
    SlashProofs,
    /// Stored sum of every entry in [`DataKey::Stakes`].
    TotalStake,
    /// Whether the pool is paused.
    Paused,
    /// The address authorized to pause and unpause.
    Governance,
    /// Challenge period in ledger sequence numbers.
    ChallengePeriod,
    /// `sentinel` -> [`Deregistration`].
    Deregistrations,
    /// Last issued governance proposal id (#1097).
    ProposalNonce,
    /// The pending [`GovernanceProposal`], if any (#1097).
    PendingProposal,
    /// Proof references in the order their slashes were resolved (#1093).
    ResolvedSlashes,
}

/// Largest page [`SentinelPool::resolved_slashes`] returns (#1093).
pub const MAX_RESOLVED_PAGE: u32 = 50;

/// A pending governance-address change, bound to a unique id (#1097).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceProposal {
    pub id: u64,
    pub governance: Address,
}

/// A recorded deregistration.
///
/// The challenge period is copied onto the record rather than read from the
/// current configuration when the exit is attempted. Without that copy,
/// shortening the period would retroactively cut short a challenge period that
/// is already running — the same hole an appeal window has.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub struct Deregistration {
    /// Ledger the address deregistered on.
    pub at: u64,
    /// The challenge period in force at that moment.
    pub challenge_period: u64,
    /// The address authorized to apply, appeal and resolve slashes.
    ///
    /// Distinct from [`DataKey::Admin`]: the admin configures the pool, the
    /// governance address operates the slashing process. Collapsing the two
    /// would mean whoever can change `min_stake` can also confiscate stake.
    Governance,
    /// Appeal window in ledger sequence numbers.
    AppealWindow,
}

/// The lifecycle of a single slash.
///
/// ```text
/// Pending ──► Upheld   (terminal)
///         └─► Reversed (terminal)
/// ```
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum SlashOutcome {
    /// Applied, awaiting appeal or resolution.
    Pending = 0,
    /// Confirmed by resolution; the stake stays removed.
    Upheld = 1,
    /// Overturned by resolution; the stake has been restored.
    Reversed = 2,
}

/// The evidence a slash is justified by.
///
/// Stored on the record and republished on [`SlashedEvent`]. The three fields
/// answer the three questions an auditor asks: *which case*, *where is the
/// record*, and *is this the record I am looking at* — the hash pins the content
/// so a mutable URI cannot quietly change what the evidence says.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlashEvidence {
    /// Unique reference for the underlying case. The replay key.
    pub proof_ref: String,
    /// Where the evidence is retrievable.
    pub uri: String,
    /// Hash of the evidence contents.
    pub content_hash: Bytes,
}

/// Everything recorded about one applied slash.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlashRecord {
    /// The sentinel the slash was applied to.
    pub sentinel: Address,
    /// Reason code, retained as an event topic for filtering.
    pub reason: Symbol,
    /// Amount removed from the stake.
    pub amount: i128,
    /// Ledger the slash was applied on.
    pub slashed_at: u64,
    /// Proof reference, URI and content hash the slash was justified by.
    pub evidence: SlashEvidence,
    /// The window in force when this slash was applied, copied onto the record
    /// so a later `set_appeal_window` cannot retroactively close an open appeal.
    pub appeal_window: u64,
    /// `slashed_at + appeal_window`. Appeals are refused at or after this ledger.
    pub appeal_deadline: u64,
    /// Whether an appeal was filed.
    pub appealed: bool,
    /// Where the record is in its lifecycle.
    pub outcome: SlashOutcome,
    /// Ledger of the resolution. `0` while `outcome == Pending`.
    pub resolved_at: u64,
}

/// The record stored under a slash proof identifier.
///
/// Keeping the whole record — not a bare `true` — is what makes the identifier
/// useful: an auditor can ask the contract "which proof is this?" and get the
/// sentinel, the amount, the reason and the ledger back, instead of having to
/// reconstruct that from the event stream.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlashProof {
    /// The sentinel the slash was applied to.
    pub sentinel: Address,
    /// The reason code, retained as an event topic for filtering. It is
    /// descriptive only; uniqueness comes from the proof identifier.
    pub reason: Symbol,
    /// The amount removed from the stake.
    pub amount: i128,
    /// Ledger sequence number the slash was applied on.
    pub slashed_at: u64,
/// A read-only snapshot of one sentinel's position.
///
/// Returned by [`SentinelPool::stake_of`]. It bundles the three facts a caller
/// needs to reason about a sentinel — how much is deposited, when the lock
/// started, and when the lock expires — so a caller does not have to make three
/// separate reads and correlate them against a moving ledger.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SentinelStake {
    /// The deposited amount. `0` for an address that has never staked.
    pub amount: i128,
    /// Ledger sequence number at which the current lock window started.
    /// `0` when `amount == 0`.
    pub staked_at: u64,
    /// Ledger sequence number at which the lock expires, i.e.
    /// `staked_at + lock_period`. Saturates at `u64::MAX`.
    pub unlock_at: u64,
    /// Whether the lock has elapsed as of the queried ledger.
    pub unlocked: bool,
}

#[contractevent]
#[derive(Clone)]
pub struct StakedEvent {
    #[topic]
    pub sentinel: Address,
    /// The amount added by this call.
    pub amount: i128,
    /// The sentinel's resulting stake, after this deposit.
    ///
    /// `amount` alone is not enough to reconstruct a sentinel's position: two
    /// deposits of the same size against different starting balances are very
    /// different events. An indexer that wants to rebuild balances from the
    /// event stream — rather than by polling `balance` — needs this field.
    pub total: i128,
    /// Ledger sequence number the deposit landed on, and therefore the ledger
    /// from which the withdrawal lock runs.
    pub staked_at: u64,
}

#[contractevent]
#[derive(Clone)]
pub struct WithdrawnEvent {
    #[topic]
    pub sentinel: Address,
    pub amount: i128,
    pub remaining: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct ThresholdUpdatedEvent {
    #[topic]
    pub actor: Address,
    pub threshold: u32,
}

/// Emitted when a slash is applied.
#[contractevent]
#[derive(Clone)]
pub struct SlashedEvent {
    #[topic]
    pub sentinel: Address,
    #[topic]
    pub reason: Symbol,
    /// The proof reference this slash was recorded under. **Not** a topic: it is
    /// high-cardinality and would bloat the topic list of a consumer filtering
    /// on "every slash for this reason".
    pub proof_ref: String,
    /// Where the justifying evidence can be retrieved.
    pub evidence_uri: String,
    /// Hash pinning the evidence contents.
    pub evidence_hash: Bytes,
    pub amount: i128,
    /// The sentinel's stake after the slash.
    pub remaining: i128,
    /// Ledger the slash was applied on.
    pub slashed_at: u64,
    /// Last ledger at which an appeal is accepted.
    pub appeal_deadline: u64,
}

/// Emitted when a sentinel or governance files an appeal.
#[contractevent]
#[derive(Clone)]
pub struct SlashAppealedEvent {
    #[topic]
    pub sentinel: Address,
    #[topic]
    pub proof_ref: String,
    /// The appealing address.
    pub appellant: Address,
    /// Free-text grounds supplied with the appeal.
    pub note: String,
    pub appealed_at: u64,
    /// The deadline the appeal was filed against, recorded so a later
    /// `set_appeal_window` cannot be used to argue the window was different.
    pub appeal_deadline: u64,
}

/// Emitted when a slash is upheld or reversed. Terminal.
#[contractevent]
#[derive(Clone)]
pub struct SlashResolvedEvent {
    #[topic]
    pub sentinel: Address,
    #[topic]
    pub proof_ref: String,
    pub outcome: SlashOutcome,
    /// The address that resolved it.
    pub resolver: Address,
    /// Amount returned to the stake. `0` for an upheld slash.
    pub restored: i128,
    /// The sentinel's stake after resolution.
    pub remaining: i128,
    pub resolved_at: u64,
}

/// Emitted when the admin changes the appeal window.
#[contractevent]
#[derive(Clone)]
pub struct AppealWindowUpdatedEvent {
    #[topic]
    pub actor: Address,
    pub appeal_window: u64,
}

/// Emitted when the admin rotates the governance address.
#[contractevent]
#[derive(Clone)]
pub struct GovernanceUpdatedEvent {
    #[topic]
    pub actor: Address,
    pub governance: Address,
    /// The caller's unique proof identifier. **Not** a topic: it is high-cardinality
    /// and would blow up the topic list of an audit consumer that subscribes to
    /// "every slash for this reason".
    pub proof_id: String,
    pub amount: i128,
    /// The sentinel's stake after the slash.
    pub remaining: i128,
    /// Ledger sequence number the slash was applied on.
    pub slashed_at: u64,
}

/// Emitted when the pause control changes state.
#[contractevent]
#[derive(Clone)]
pub struct PauseChangedEvent {
    #[topic]
    pub actor: Address,
    /// Whether the pool is paused after this call.
    pub paused: bool,
    /// The pool-wide aggregate after this call.
    pub total_stake: i128,
}

/// Emitted when a sentinel leaves the set.
#[contractevent]
#[derive(Clone)]
pub struct DeregisteredEvent {
    #[topic]
    pub sentinel: Address,
    /// Ledger the deregistration was recorded on.
    pub deregistered_at: u64,
    /// The ledger from which a full exit becomes available.
    pub withdrawable_at: u64,
    /// The balance the sentinel still has at stake during the challenge period.
    pub stake_at_deregistration: i128,
}

#[contract]
pub struct SentinelPool;

#[contractimpl]
impl SentinelPool {
    /// # Configure the pool
    ///
    /// `admin` configures the pool. `governance` operates the slashing process.
    /// They are separate keys on purpose: collapsing them would mean whoever can
    /// change `min_stake` can also confiscate stake.
    ///
    /// `governance` may be the same address as `admin` for a single-operator
    /// deployment, but the contract never *infers* it — the lookup has no
    /// fallback, so an unset governance key refuses every slash rather than
    /// accepting the caller.
    /// All-or-nothing. Every parameter is validated **before** the first write,
    /// so a rejected call leaves storage untouched and the contract still
    /// initializable — [`Self::is_initialized`] keeps reporting `false` and a
    /// later, corrected call still succeeds.
    ///
    /// Validation order is fixed and each step is a pure predicate:
    ///
    /// 1. `min_stake > 0` — a non-positive minimum makes every stake
    ///    trivially valid and every sentinel worthless.
    /// 2. `1 <= lock_period <= MAX_LOCK_PERIOD` — a zero lock removes the
    ///    withdrawal delay entirely, and an unbounded lock could exceed the
    ///    `u32` ledger sequence space and freeze stake permanently.
    /// 3. `threshold > 0` — a zero quorum means any single signature governs.
    ///
    /// Only then is `admin.require_auth()` collected, the re-initialization
    /// guard consulted, and storage written.
    ///
    /// # Errors
    /// * [`Error::InvalidStake`] — `min_stake <= 0`.
    /// * [`Error::InvalidLockPeriod`] — `lock_period` is zero or too large.
    /// * [`Error::InvalidThreshold`] — `threshold == 0`.
    /// * [`Error::Unauthorized`] — the pool is already initialized.
    pub fn initialize(
        env: Env,
        admin: Address,
        governance: Address,
        min_stake: i128,
        lock_period: u64,
        threshold: u32,
    ) -> Result<(), Error> {
        // 1. Parameters — pure, before auth and before storage.
        if min_stake <= 0 {
            return Err(Error::InvalidStake);
        }
        if lock_period == 0 || lock_period > MAX_LOCK_PERIOD {
            return Err(Error::InvalidLockPeriod);
        }
        if threshold == 0 {
            return Err(Error::InvalidThreshold);
        }

        // 2. Auth comes after every pure check.
        admin.require_auth();

        // 3. Re-initialization guard, still before the first write.
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::Unauthorized);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::Governance, &governance);
        env.storage().instance().set(&DataKey::MinStake, &min_stake);
        env.storage().instance().set(&DataKey::LockPeriod, &lock_period);
        env.storage().instance().set(&DataKey::Threshold, &threshold);
        env.storage()
            .instance()
            .set(&DataKey::AppealWindow, &DEFAULT_APPEAL_WINDOW_LEDGERS);
        env.storage().instance().set(&DataKey::Stakes, &Map::<Address, i128>::new(&env));
        env.storage().instance().set(&DataKey::StakedAt, &Map::<Address, u64>::new(&env));
        env.storage()
            .instance()
            .set(&DataKey::SlashProofs, &Map::<String, SlashRecord>::new(&env));

        Ok(())
    }

    /// The address authorized to apply, appeal and resolve slashes.
    pub fn governance(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Governance)
    }

    /// The appeal window in force, in ledger sequence numbers.
    ///
    /// `0` when unset — which also means "no appeal is possible", because a zero
    /// window closes the deadline on the ledger the slash was applied.
    pub fn appeal_window(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::AppealWindow)
            .unwrap_or(0)
    }

    /// Fail unless `caller` is the configured governance address.
    ///
    /// Two distinct refusals, because they are two different operational
    /// problems: a pool that was never configured for governance, and a caller
    /// that is not the configured address.
    fn require_governance(env: &Env, caller: &Address) -> Result<(), Error> {
        let stored: Option<Address> = env.storage().instance().get(&DataKey::Governance);
        match stored {
            Some(governance) if governance == *caller => Ok(()),
            Some(_) => Err(Error::NotGovernance),
            None => Err(Error::GovernanceNotConfigured),
        }
    }

    /// Fail unless `caller` is the configured admin.
    fn require_admin(env: &Env, caller: &Address) -> Result<(), Error> {
        let stored: Option<Address> = env.storage().instance().get(&DataKey::Admin);
        match stored {
            Some(admin) if admin == *caller => Ok(()),
            _ => Err(Error::Unauthorized),
        }
    }

    /// # Rotate the governance address
    ///
    /// Admin-only. Rotating governance does not disturb any open appeal window:
    /// each [`SlashRecord`] copies the window that was in force when its slash
    /// was applied.
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] — `admin` is not the configured admin.
    pub fn set_governance(env: Env, admin: Address, governance: Address) -> Result<(), Error> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        env.storage()
            .instance()
            .set(&DataKey::Governance, &governance);

        GovernanceUpdatedEvent {
            actor: admin,
            governance,
        }
        .publish(&env);

        Ok(())
    }

    /// # Set the appeal window
    ///
    /// Admin-only, and **not retroactive**: records already written keep the
    /// window that was in force when their slash was applied, so shortening the
    /// window cannot be used to close an appeal a sentinel is already entitled
    /// to file.
    ///
    /// # Errors
    /// * [`Error::InvalidAppealWindow`] — zero, or above
    ///   [`MAX_APPEAL_WINDOW_LEDGERS`].
    /// * [`Error::Unauthorized`] — `admin` is not the configured admin.
    pub fn set_appeal_window(env: Env, admin: Address, window: u64) -> Result<(), Error> {
        if window == 0 || window > MAX_APPEAL_WINDOW_LEDGERS {
            return Err(Error::InvalidAppealWindow);
        }

        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        env.storage().instance().set(&DataKey::AppealWindow, &window);

        AppealWindowUpdatedEvent {
            actor: admin,
            appeal_window: window,
        }
        .publish(&env);
            .set(&DataKey::SlashProofs, &Map::<String, SlashProof>::new(&env));

        // The aggregate starts at zero and is written by every mutation that
        // moves a balance. Seeding it here means it exists from the first
        // ledger, so a reader never has to distinguish "no stake" from "never
        // initialized".
        env.storage().instance().set(&DataKey::TotalStake, &0i128);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage()
            .instance()
            .set(&DataKey::ChallengePeriod, &DEFAULT_CHALLENGE_PERIOD_LEDGERS);
        env.storage()
            .instance()
            .set(&DataKey::Deregistrations, &Map::<Address, u64>::new(&env));

        Ok(())
    }

    /// # The pool-wide aggregate
    ///
    /// A stored running total, not a fold over [`DataKey::Stakes`] at read
    /// time. `stake`, `withdraw` and `slash` each update it with checked
    /// arithmetic in the same call that updates the balance, so it cannot drift
    /// away from the balances it summarizes.
    pub fn total_stake(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalStake)
            .unwrap_or(0)
    }

    /// Whether the pool is paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// The challenge period in force, in ledger sequence numbers.
    pub fn challenge_period(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ChallengePeriod)
            .unwrap_or(DEFAULT_CHALLENGE_PERIOD_LEDGERS)
    }

    /// Fail unless the pool is not paused.
    fn require_not_paused(env: &Env) -> Result<(), Error> {
        let paused: bool = env.storage().instance().get(&DataKey::Paused).unwrap_or(false);
        if paused {
            Err(Error::PoolPaused)
        } else {
            Ok(())
        }
    }

    /// Fail unless `caller` is the configured governance address.
    ///
    /// There is no fallback to the caller: a pool with no governance address
    /// cannot be paused by anyone, rather than being pausable by whichever
    /// address happened to sign the transaction.
    fn require_governance(env: &Env, caller: &Address) -> Result<(), Error> {
        let stored: Option<Address> = env.storage().instance().get(&DataKey::Governance);
        match stored {
            Some(governance) if governance == *caller => Ok(()),
            Some(_) => Err(Error::Unauthorized),
            None => Err(Error::PauseNotAuthorized),
        }
    }

    /// Fail unless `caller` is the configured admin.
    fn require_admin(env: &Env, caller: &Address) -> Result<(), Error> {
        let stored: Option<Address> = env.storage().instance().get(&DataKey::Admin);
        match stored {
            Some(admin) if admin == *caller => Ok(()),
            _ => Err(Error::Unauthorized),
        }
    }

    /// # Rotate the pause authority
    ///
    /// Admin-only. Pausing is an operational power — it stops the pool moving
    /// value — so it is held by governance rather than by whoever can change
    /// the configuration. Until this is called, `pause` and `unpause` are
    /// refused with [`Error::PauseNotAuthorized`].
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] — `admin` is not the configured admin.
    pub fn set_governance(env: Env, admin: Address, governance: Address) -> Result<(), Error> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        env.storage()
            .instance()
            .set(&DataKey::Governance, &governance);

        GovernanceUpdatedEvent {
            actor: admin,
            governance,
        }
        .publish(&env);

        Ok(())
    }

    /// # Set the deregistration challenge period
    ///
    /// Admin-only. Not retroactive: a deregistration records the ledger it
    /// happened on, so changing the period afterwards cannot shorten a challenge
    /// period that is already running.
    ///
    /// # Errors
    /// * [`Error::InvalidChallengePeriod`] — zero, or above
    ///   [`MAX_CHALLENGE_PERIOD_LEDGERS`].
    /// * [`Error::Unauthorized`] — `admin` is not the configured admin.
    pub fn set_challenge_period(env: Env, admin: Address, period: u64) -> Result<(), Error> {
        if period == 0 || period > MAX_CHALLENGE_PERIOD_LEDGERS {
            return Err(Error::InvalidChallengePeriod);
        }

        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        env.storage()
            .instance()
            .set(&DataKey::ChallengePeriod, &period);

        Ok(())
    }

    /// # Pause the pool
    ///
    /// # The pause matrix
    ///
    /// | Call | Paused | Not paused |
    /// | --- | --- | --- |
    /// | `stake` | `PoolPaused` | succeeds |
    /// | `withdraw` | `PoolPaused` | succeeds |
    /// | `slash` | `PoolPaused` | succeeds |
    /// | `deregister` | `PoolPaused` | succeeds |
    /// | `pause` | succeeds (idempotent) | succeeds |
    /// | `unpause` | succeeds | `PoolPaused` refused — nothing to undo |
    /// | `set_threshold`, `set_min_stake` | succeeds | succeeds |
    /// | `set_governance`, `set_challenge_period` | succeeds | succeeds |
    /// | every read | succeeds | succeeds |
    ///
    /// Value movement stops; configuration and the emergency controls do not.
    /// A pause that also froze `unpause` or the configuration setters would be a
    /// one-way trip for the operator dealing with the incident.
    ///
    /// # Errors
    /// * [`Error::PauseNotAuthorized`] — no governance address is configured.
    /// * [`Error::Unauthorized`] — `caller` is not the governance address.
    pub fn pause(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        Self::require_governance(&env, &caller)?;

        env.storage().instance().set(&DataKey::Paused, &true);

        PauseChangedEvent {
            actor: caller,
            paused: true,
            total_stake: Self::total_stake(env.clone()),
        }
        .publish(&env);

        Ok(())
    }

    /// Lift the pause. Only meaningful while paused — unpausing a running pool
    /// is refused rather than silently accepted, so a caller that believes it
    /// lifted an incident cannot be wrong about it.
    pub fn unpause(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        Self::require_governance(&env, &caller)?;

        if !Self::is_paused(env.clone()) {
            return Err(Error::PoolPaused);
        }

        env.storage().instance().set(&DataKey::Paused, &false);

        PauseChangedEvent {
            actor: caller,
            paused: false,
            total_stake: Self::total_stake(env.clone()),
        }
        .publish(&env);

        Ok(())
    /// # Deposit stake
    ///
    /// # Lock extension policy
    ///
    /// **A top-up never extends a lock that is still running.** `staked_at` is
    /// left untouched while `now < staked_at + lock_period`, and is set to the
    /// current ledger once that window has elapsed.
    ///
    /// Both halves of that matter. Allowing the top-up to move the window would
    /// let a sentinel push their own unlock date out indefinitely by depositing
    /// one unit repeatedly — the lock would be a fee, not a constraint.
    /// Resetting it unconditionally on every deposit would be worse: a top-up
    /// landing one ledger before expiry would silently extend the lock by the
    /// full `lock_period`, which is a trap rather than a policy.
    /// Whether [`Self::initialize`] has completed.
    ///
    /// A view, not a guard: it reports state and writes nothing. The enforcing
    /// form is `require_initialized`.
    pub fn is_initialized(env: Env) -> bool {
        env.storage().instance().has(&DataKey::Admin)
    }

    /// Fail unless the pool has been initialized.
    ///
    /// Every state-changing entry point opens with this. Without it the
    /// fallbacks in the read paths (`min_stake -> 0`, `lock_period -> 0`) turn
    /// an uninitialized pool into one with a zero minimum stake and no lock,
    /// which is a strictly weaker contract than the one the admin intended.
    ///
    /// Checked before `require_auth()` so a call against an uninitialized pool
    /// fails with a specific, stable error instead of asking the caller for an
    /// authorization that can never succeed.
    fn require_initialized(env: &Env) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            Ok(())
        } else {
            Err(Error::NotInitialized)
        }
    }

    /// The configured admin, or [`Error::Unauthorized`] when there is none.
    ///
    /// A stored admin is mandatory. It used to be optional — the lookup fell
    /// back to `unwrap_or_else(|| caller.clone())`, which meant that on an
    /// uninitialized pool *any* address passed the equality check and could
    /// write the threshold it had just authenticated as. Requiring the stored
    /// value removes that path entirely.
    fn require_admin(env: &Env, caller: &Address) -> Result<(), Error> {
        let stored: Option<Address> = env.storage().instance().get(&DataKey::Admin);
        match stored {
            Some(stored) if stored == *caller => Ok(()),
            _ => Err(Error::Unauthorized),
        }
    }

    /// # Add to a sentinel's stake
    ///
    /// Refused while the pool is paused, and refused for a deregistered address
    /// with [`Error::AlreadyDeregistered`]. Allowing a top-up during the
    /// challenge period would let a sentinel reset it and escape the delay by
    /// depositing a single unit; a deregistered address must either finish its
    /// exit or wait it out.
    ///
    /// The new balance and the aggregate are both derived with checked
    /// arithmetic **before** either is written, so an overflow leaves the
    /// balance and the total exactly as they were.
    ///
    /// # Errors
    /// * [`Error::PoolPaused`] — the pool is paused.
    /// * [`Error::AlreadyDeregistered`] — the address is on its way out.
    /// * [`Error::InvalidStake`] — `amount <= 0`, or the resulting balance
    ///   would overflow `i128`.
    /// * [`Error::StakeBelowMinimum`] — the resulting balance is under
    ///   `min_stake`.
    pub fn stake(env: Env, sentinel: Address, amount: i128) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
    /// The new balance is computed with `checked_add`, so an overflowing
    /// deposit fails with [`Error::InvalidStake`] **before** any write. No
    /// partial state is produced: `Stakes`, `StakedAt` and the emitted event
    /// are all downstream of that check.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — the pool is not configured.
    /// * [`Error::InvalidStake`] — `amount <= 0`, or the resulting balance
    ///   would overflow `i128`.
    /// # Deposit stake
    ///
    /// The deposit is added to whatever the address already had, so a sentinel
    /// can top up without withdrawing first. The resulting balance is checked
    /// against `min_stake` **after** the addition, which is what makes the floor
    /// hold for the first stake as well as for later ones.
    ///
    /// The resulting balance and the ledger the lock starts from are both
    /// published in [`StakedEvent`], so the position after the call is
    /// reconstructible from the event stream alone.
    ///
    /// # Errors
    /// * [`Error::InvalidStake`] — `amount <= 0`.
    /// * [`Error::StakeBelowMinimum`] — the resulting balance is under
    ///   `min_stake`.
    /// * [`Error::InvalidLockPeriod`] — the stored lock window is not
    ///   representable.
    pub fn stake(env: Env, sentinel: Address, amount: i128) -> Result<(), Error> {
        Self::require_initialized(&env)?;

        if amount <= 0 {
            return Err(Error::InvalidStake);
        }

        sentinel.require_auth();

        if Self::deregistration(env.clone(), sentinel.clone()).is_some() {
            return Err(Error::AlreadyDeregistered);
        }

        let mut stakes: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&DataKey::Stakes)
            .unwrap_or_else(|| Map::new(&env));

        let current = stakes.get(sentinel.clone()).unwrap_or(0);

        // Checked arithmetic. `checked_add` returns `None` only on overflow, so
        // the `InvalidStake` branch below is reached without `stakes` having
        // been touched — `current` is a copy, not a reference.
        let new_total = current
            .checked_add(amount)
            .ok_or(Error::InvalidStake)?;

        let min_stake = Self::min_stake(env.clone());
        if new_total < min_stake {
            return Err(Error::StakeBelowMinimum);
        }

        // The aggregate moves by the same `amount` as the balance, checked
        // before either write. Reading it once and reusing the value keeps the
        // balance and the total derived from one arithmetic step rather than two
        // that could drift.
        let aggregate = Self::total_stake(env.clone());
        let new_aggregate = aggregate
            .checked_add(amount)
            .ok_or(Error::InvalidStake)?;

        stakes.set(sentinel.clone(), new_total);
        env.storage().instance().set(&DataKey::Stakes, &stakes);
        env.storage()
            .instance()
            .set(&DataKey::TotalStake, &new_aggregate);

        // The lock window starts on the ledger the deposit lands on. Read once
        // and reused, so the balance and the lock timestamp in `StakedEvent`
        // can never disagree about which ledger this was.
        let ledger_seq = u64::from(env.ledger().sequence());

        let mut staked_at: Map<Address, u64> = env
            .storage()
            .instance()
            .get(&DataKey::StakedAt)
            .unwrap_or_else(|| Map::new(&env));

        let now = u64::from(env.ledger().sequence());

        // `Option`, not `unwrap_or(0)`: genesis ledger 0 is a real `staked_at`
        // and must not be confused with "never staked".
        let existing: Option<u64> = staked_at.get(sentinel.clone());
        let effective_staked_at = match existing {
            // The window is still running — leave it alone.
            Some(last) if now < Self::lock_expiry_at(&env, last)? => last,
            // First stake, or the previous window has elapsed: start a new one.
            _ => now,
        };

        staked_at.set(sentinel.clone(), effective_staked_at);
        staked_at.set(sentinel.clone(), ledger_seq);
        env.storage().instance().set(&DataKey::StakedAt, &staked_at);

        StakedEvent {
            sentinel: sentinel.clone(),
            amount,
            total: new_total,
            staked_at: ledger_seq,
        }
        .publish(&env);

        Ok(())
    }

/// The ledger at which a sentinel's current lock expires.
///
/// `staked_at + lock_period`, computed with `checked_add` — an unrepresentable
/// window is [`Error::InvalidLockPeriod`], not a saturated `u64::MAX` that
/// would read as "locked forever" without saying so.
///
/// `None` only for an address that has never staked. An address whose first
/// deposit landed on genesis reports `Some(lock_period)`, because its recorded
/// window start is a real `0`.
pub fn unlock_at(env: Env, sentinel: Address) -> Result<Option<u64>, Error> {
        let staked_at: Map<Address, u64> = env
            .storage()
            .instance()
            .get(&DataKey::StakedAt)
            .unwrap_or_else(|| Map::new(&env));

        match staked_at.get(sentinel) {
            Some(last) => Self::lock_expiry_at(&env, last).map(Some),
            None => Ok(None),
        }
    }

    /// `staked_at + lock_period`, or [`Error::InvalidLockPeriod`] on overflow.
    fn lock_expiry_at(env: &Env, staked_at: u64) -> Result<u64, Error> {
        let lock_period: u64 = env
            .storage()
            .instance()
            .get(&DataKey::LockPeriod)
            .unwrap_or(0);

        staked_at
            .checked_add(lock_period)
            .ok_or(Error::InvalidLockPeriod)
    /// # One sentinel's full position
    ///
    /// A view. Reads storage and the ledger, writes nothing, and emits nothing.
    ///
    /// An address that has never staked is **not** an error: it reports the
    /// zero record (`amount == 0`, `staked_at == 0`, `unlocked == true`). That
    /// keeps the query total — a caller iterating candidates never has to
    /// special-case `None` for "not a sentinel yet", which is different from
    /// "the read failed".
    ///
    /// `unlock_at` saturates rather than overflowing: this is a reporting
    /// value, and reporting `u64::MAX` for an unreachable unlock ledger is more
    /// useful to a caller than failing the read.
    pub fn stake_of(env: Env, sentinel: Address) -> SentinelStake {
        let amount = Self::balance(env.clone(), sentinel.clone());
        let lock_period: u64 = env
            .storage()
            .instance()
            .get(&DataKey::LockPeriod)
            .unwrap_or(0);

        if amount == 0 {
            return SentinelStake {
                amount: 0,
                staked_at: 0,
                unlock_at: 0,
                unlocked: true,
            };
        }

        let staked_at: u64 = Self::staked_at(env.clone(), sentinel);
        let unlock_at = staked_at.saturating_add(lock_period);
        let now = u64::from(env.ledger().sequence());

        SentinelStake {
            amount,
            staked_at,
            unlock_at,
            unlocked: now >= unlock_at,
        }
    }

    /// # Every deposited amount in the pool
    ///
    /// A view, and deliberately **computed rather than stored**: it folds the
    /// `Stakes` map at read time, so it cannot drift out of step with the
    /// per-address balances the way a cached running total can. The cost is one
    /// pass over the map, which is bounded by the sentinel set size — the same
    /// order as any governance read that has to see every sentinel.
    ///
    /// Sums saturate at `i128::MAX` rather than wrapping.
    pub fn total_active_stake(env: Env) -> i128 {
        let stakes: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&DataKey::Stakes)
            .unwrap_or_else(|| Map::new(&env));

        let mut total: i128 = 0;
        for amount in stakes.values() {
            total = total.saturating_add(amount);
        }
        total
    }

    /// The ledger sequence number the sentinel's current lock started on.
    ///
    /// `0` for an address that has never staked, which is also the genesis
    /// ledger — so a caller that only needs "is this address locked?" should
    /// read [`Self::stake_of`], which resolves the ambiguity.
    pub fn staked_at(env: Env, sentinel: Address) -> u64 {
        let staked_at: Map<Address, u64> = env
            .storage()
            .instance()
            .get(&DataKey::StakedAt)
            .unwrap_or_else(|| Map::new(&env));
        staked_at.get(sentinel).unwrap_or(0)
    }

    pub fn balance(env: Env, sentinel: Address) -> i128 {
        let stakes: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&DataKey::Stakes)
            .unwrap_or_else(|| Map::new(&env));
        stakes.get(sentinel).unwrap_or(0)
    }

    pub fn threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(0)
    }

    pub fn min_stake(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::MinStake)
            .unwrap_or(0)
    }

    pub fn quorum_threshold(env: Env, required: u32) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(required)
    }

    /// # Update the governance quorum threshold
    ///
    /// Two independent gates, both before the write:
    ///
    /// * the pool is initialized (so there is an admin to compare against), and
    /// * `admin` equals the stored admin — checked against storage, never
    ///   against the caller's own argument.
    ///
    /// `threshold == 0` is rejected with [`Error::InvalidThreshold`] before
    /// `require_auth`, so an invalid value costs the caller nothing and writes
    /// nothing.
    ///
    /// # Errors
    /// * [`Error::InvalidThreshold`] — `threshold == 0`.
    /// * [`Error::NotInitialized`] — the pool is not configured.
    /// * [`Error::Unauthorized`] — `admin` is not the configured admin.
    pub fn set_threshold(env: Env, admin: Address, threshold: u32) -> Result<(), Error> {
        if threshold == 0 {
            return Err(Error::InvalidThreshold);
        }

        Self::require_initialized(&env)?;

        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        env.storage().instance().set(&DataKey::Threshold, &threshold);

        ThresholdUpdatedEvent {
            actor: admin.clone(),
            threshold,
        }
        .publish(&env);

        Ok(())
    }

    /// # Update the minimum stake
    ///
    /// Same authorization shape as [`Self::set_threshold`]: initialized pool,
    /// configured admin, positive value — all checked before the write.
    ///
    /// # Errors
    /// * [`Error::InvalidStake`] — `min_stake <= 0`.
    /// * [`Error::NotInitialized`] — the pool is not configured.
    /// * [`Error::Unauthorized`] — `admin` is not the configured admin.
    pub fn set_min_stake(env: Env, admin: Address, min_stake: i128) -> Result<(), Error> {
        if min_stake <= 0 {
            return Err(Error::InvalidStake);
        }

        Self::require_initialized(&env)?;

        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        env.storage().instance().set(&DataKey::MinStake, &min_stake);
        Ok(())
    }

    /// # Withdraw part of a sentinel's stake
    ///
    /// Refused while the pool is paused.
    ///
    /// # Two withdrawal modes
    ///
    /// * **Registered sentinel** (the default). The remainder must stay at or
    ///   above `min_stake`; a withdrawal that would cross the floor is
    ///   [`Error::StakeBelowMinimum`]. Leaving the set has its own step —
    ///   [`Self::deregister`].
    /// * **Deregistered sentinel.** After [`Self::deregister`] and once the
    ///   challenge period has elapsed, the whole balance may be withdrawn and
    ///   the `min_stake` floor does not apply. The withdrawal lock still does.
    ///
    /// # Accounting order
    ///
    /// Checks run in this order and nothing is written until all of them pass:
    ///
    /// 1. the pool is not paused;
    /// 2. `amount > 0`;
    /// 3. `amount <= balance` — [`Error::InsufficientBalance`];
    /// 4. the withdrawal lock has elapsed — [`Error::LockPeriodActive`];
    /// 5. a full exit is claimed only by a deregistered sentinel past its
    ///    challenge period — [`Error::NotDeregistered`] or
    ///    [`Error::ChallengePeriodActive`];
    /// 6. `balance - amount` does not underflow — `checked_sub`;
    /// 7. the remainder clears the floor, unless this is an exit.
    ///
    /// # Errors
    /// * [`Error::PoolPaused`] — the pool is paused.
    /// * [`Error::InvalidStake`] — `amount <= 0`.
    /// * [`Error::InsufficientBalance`] — `amount` exceeds the balance.
    /// * [`Error::LockPeriodActive`] — the withdrawal lock has not elapsed.
    /// * [`Error::NotDeregistered`] — a full exit without deregistering first.
    /// * [`Error::ChallengePeriodActive`] — the challenge period has not
    ///   elapsed.
    /// * [`Error::StakeBelowMinimum`] — the remainder would fall under
    ///   `min_stake`.
    pub fn withdraw(env: Env, sentinel: Address, amount: i128) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
    /// Accounting is checked end to end, in this order, with no write until
    /// every check has passed:
    ///
    /// 1. the pool is initialized;
    /// 2. `amount > 0`;
    /// 3. `amount <= current` — otherwise [`Error::InsufficientBalance`];
    /// 4. the lock period has elapsed;
    /// 5. `current - amount` does not underflow — `checked_sub`, reported as
    ///    [`Error::InsufficientBalance`] rather than a panic;
    /// 6. the remainder stays at or above `min_stake`.
    ///
    /// Because the balance map is only written after step 6, every rejection
    /// leaves the sentinel's balance exactly as it was.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — the pool is not configured.
    /// * [`Error::InvalidStake`] — `amount <= 0`.
    /// * [`Error::InsufficientBalance`] — `amount` exceeds the balance, or the
    ///   subtraction would underflow.
    /// * [`Error::LockPeriodActive`] — the lock has not elapsed.
    /// * [`Error::StakeBelowMinimum`] — the remainder would fall under
    ///   `min_stake`.
    /// # The floor rule
    ///
    /// A withdrawal may take a registered sentinel down to **exactly**
    /// `min_stake` and no further; anything that would leave the balance below
    /// `min_stake` is refused with [`Error::StakeBelowMinimum`], including a
    /// withdrawal of the entire balance. See the module docs for why exiting
    /// the set is a lifecycle event rather than an arithmetic side effect.
    ///
    /// The same rule is enforced on the way in by [`Self::stake`], so the floor
    /// holds for every balance the pool ever exposes — there is no window in
    /// which a registered sentinel is under-funded.
    ///
    /// # Accounting order
    ///
    /// Checks run in this order and the balance map is written only after all
    /// of them pass:
    ///
    /// 1. `amount > 0` — [`Error::InvalidStake`];
    /// 2. `amount <= balance` — [`Error::InsufficientBalance`];
    /// 3. the lock has elapsed — [`Error::LockPeriodActive`];
    /// 4. `balance - amount` does not underflow — `checked_sub`, reported as
    ///    [`Error::InsufficientBalance`];
    /// 5. the remainder is `>= min_stake` — [`Error::StakeBelowMinimum`].
    ///
    /// Step 2 makes step 4 unreachable in practice; `checked_sub` is kept
    /// anyway so that `remaining` is derived by checked arithmetic on the line
    /// that consumes it, rather than by a subtraction that a future edit could
    /// quietly un-check.
    ///
    /// Because nothing is written until step 5 succeeds, every rejection —
    /// invalid amount, excessive amount, active lock, below-minimum remainder —
    /// leaves the sentinel's balance exactly as it was, and emits no event.
    pub fn withdraw(env: Env, sentinel: Address, amount: i128) -> Result<(), Error> {
        Self::require_initialized(&env)?;

        if amount <= 0 {
            return Err(Error::InvalidStake);
        }

        sentinel.require_auth();

        let mut stakes: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&DataKey::Stakes)
            .unwrap_or_else(|| Map::new(&env));

        let current = stakes.get(sentinel.clone()).unwrap_or(0);
        if amount > current {
            return Err(Error::InsufficientBalance);
        }

        let lock_period: u64 = env
            .storage()
            .instance()
            .get(&DataKey::LockPeriod)
            .unwrap_or(0);

        if lock_period > 0 {
            let staked_at: Map<Address, u64> = env
                .storage()
                .instance()
                .get(&DataKey::StakedAt)
                .unwrap_or_else(|| Map::new(&env));
            let last_staked = staked_at.get(sentinel.clone()).unwrap_or(0);

            // Compare ledgers directly rather than subtracting: `now - last`
            // saturates, and a saturated subtraction would silently report "the
            // lock has elapsed" for a window that has not been reached. Deriving
            // the unlock ledger with `checked_add` keeps the comparison exact at
            // both boundaries.
            let unlock = Self::lock_expiry_at(&env, last_staked)?;
            if u64::from(env.ledger().sequence()) < unlock {
                return Err(Error::LockPeriodActive);
            }
        }

        // Checked subtraction. `amount <= current` above already rules out an
        // underflow, so this `ok_or` arm is a belt-and-braces guard that keeps
        // the invariant local to this line: `remaining` is derived by checked
        // arithmetic, never by subtraction that can wrap.
        let remaining = current
            .checked_sub(amount)
            .ok_or(Error::InsufficientBalance)?;

        // A full exit is only available to a sentinel that deregistered and
        // waited out the challenge period. The deregistration is resolved
        // *before* the floor is consulted, so an ordinary partial withdrawal
        // that would dip under `min_stake` reports `StakeBelowMinimum` while a
        // deliberate full exit reports why *it* is not allowed yet.
        let is_exit = remaining == 0;

        if is_exit {
            let deregistration = Self::deregistration(env.clone(), sentinel.clone())
                .ok_or(Error::NotDeregistered)?;
            let withdrawable_at = deregistration
                .at
                .saturating_add(deregistration.challenge_period);
            if u64::from(env.ledger().sequence()) < withdrawable_at {
                return Err(Error::ChallengePeriodActive);
            }
        }

        if !is_exit {
            let min_stake = Self::min_stake(env.clone());
            if remaining < min_stake {
                return Err(Error::StakeBelowMinimum);
            }
        // The floor rule. `remaining == min_stake` is allowed; only going under
        // it is refused.
        let min_stake = Self::min_stake(env.clone());
        if remaining < min_stake {
            return Err(Error::StakeBelowMinimum);
        }

        let aggregate = Self::total_stake(env.clone());
        let new_aggregate = aggregate
            .checked_sub(amount)
            .ok_or(Error::InsufficientBalance)?;

        stakes.set(sentinel.clone(), remaining);
        env.storage().instance().set(&DataKey::Stakes, &stakes);
        env.storage()
            .instance()
            .set(&DataKey::TotalStake, &new_aggregate);

        // Completing the exit closes out the deregistration, so a returning
        // sentinel starts clean: no stale record, and a fresh challenge period
        // if it deregisters again.
        if is_exit {
            let mut deregistrations: Map<Address, Deregistration> = env
                .storage()
                .instance()
                .get(&DataKey::Deregistrations)
                .unwrap_or_else(|| Map::new(&env));
            deregistrations.remove(sentinel.clone());
            env.storage()
                .instance()
                .set(&DataKey::Deregistrations, &deregistrations);
        }

        WithdrawnEvent {
            sentinel: sentinel.clone(),
            amount,
            remaining,
        }
        .publish(&env);

        Ok(())
    }

    /// # Leave the sentinel set
    ///
    /// Records that `sentinel` is on its way out, starting the challenge period.
    /// The stake stays in the pool throughout — deregistering is not a
    /// withdrawal, and the balance is still there for a slash under review.
    ///
    /// Refused while the pool is paused, and refused twice: an address with no
    /// stake has nothing to deregister from, and an address that already has is
    /// not given a fresh challenge period.
    ///
    /// # Errors
    /// * [`Error::PoolPaused`] — the pool is paused.
    /// * [`Error::InvalidStake`] — the address holds no stake.
    /// * [`Error::AlreadyDeregistered`] — already deregistered.
    pub fn deregister(env: Env, sentinel: Address) -> Result<(), Error> {
        Self::require_not_paused(&env)?;

        sentinel.require_auth();

        if Self::deregistration(env.clone(), sentinel.clone()).is_some() {
            return Err(Error::AlreadyDeregistered);
        }

        let stake = Self::balance(env.clone(), sentinel.clone());
        if stake <= 0 {
            return Err(Error::InvalidStake);
        }

        let at = u64::from(env.ledger().sequence());
        let challenge_period = Self::challenge_period(env.clone());

        let mut deregistrations: Map<Address, Deregistration> = env
            .storage()
            .instance()
            .get(&DataKey::Deregistrations)
            .unwrap_or_else(|| Map::new(&env));
        deregistrations.set(
            sentinel.clone(),
            Deregistration {
                at,
                challenge_period,
            },
        );
        env.storage()
            .instance()
            .set(&DataKey::Deregistrations, &deregistrations);

        DeregisteredEvent {
            sentinel,
            deregistered_at: at,
            withdrawable_at: at.saturating_add(challenge_period),
            stake_at_deregistration: stake,
        }
        .publish(&env);

        Ok(())
    }

    /// The ledger a sentinel deregistered on, or `None` while registered.
    pub fn deregistered_at(env: Env, sentinel: Address) -> Option<u64> {
        Self::deregistration(env, sentinel).map(|d| d.at)
    }

    /// The ledger from which a deregistered sentinel may withdraw its balance.
    ///
    /// `None` while the address is still registered. The deadline is computed
    /// from the period that was in force at deregistration, so it is stable even
    /// if the admin changes the period afterwards.
    pub fn withdrawable_at(env: Env, sentinel: Address) -> Option<u64> {
        Self::deregistration(env, sentinel)
            .map(|d| d.at.saturating_add(d.challenge_period))
    }

    /// The recorded deregistration for `sentinel`, if any.
    fn deregistration(env: Env, sentinel: Address) -> Option<Deregistration> {
        let deregistrations: Map<Address, Deregistration> = env
            .storage()
            .instance()
            .get(&DataKey::Deregistrations)
            .unwrap_or_else(|| Map::new(&env));
        deregistrations.get(sentinel)
    }

    /// # Would this address count as an active sentinel at ledger `at_ledger`?
    ///
    /// One read, three conditions, all of which the contract itself enforces:
    ///
    /// 1. the balance is at or above `min_stake`;
    /// 2. the address is not deregistered;
    /// 3. the withdrawal lock has elapsed at `at_ledger`.
    ///
    /// The ledger is a parameter so a caller can ask the hypothetical question —
    /// "will this sentinel be eligible at the next halving?" — without waiting
    /// for it. It defaults to the current ledger for callers that just want the
    /// present-tense answer.
    ///
    /// Returns `false` rather than an error for an unknown address: "not
    /// eligible" is the answer, not a failure.
    pub fn is_eligible(env: Env, sentinel: Address, at_ledger: u32) -> bool {
        if Self::deregistered_at(env.clone(), sentinel.clone()).is_some() {
            return false;
        }

        let balance = Self::balance(env.clone(), sentinel.clone());
        if balance < Self::min_stake(env.clone()) {
            return false;
        }

        let lock_period: u64 = env
            .storage()
            .instance()
            .get(&DataKey::LockPeriod)
            .unwrap_or(0);

        let staked_at: Map<Address, u64> = env
            .storage()
            .instance()
            .get(&DataKey::StakedAt)
            .unwrap_or_else(|| Map::new(&env));
        let last_staked = staked_at.get(sentinel).unwrap_or(0);
        let elapsed = u64::from(at_ledger).saturating_sub(last_staked);

        elapsed >= lock_period
    }

    /// Refused while the pool is paused, and the pool-wide aggregate moves with
    /// the slashed balance in the same checked step.
    ///
    /// # Errors
    /// * [`Error::PoolPaused`] — the pool is paused.
    /// # Apply a fraud slash
    ///
    /// Requires the configured governance address. The check is a pure storage
    /// comparison against [`DataKey::Governance`] with **no fallback to the
    /// caller** — an unconfigured pool refuses every slash with
    /// [`Error::GovernanceNotConfigured`] instead of being governed by whoever
    /// signed the transaction.
    ///
    /// # Evidence
    ///
    /// `evidence` is stored on the record and republished on [`SlashedEvent`],
    /// so an off-chain consumer can tell *why* a balance changed without
    /// correlating against a separate evidence store. A record with no proof
    /// reference or no URI is [`Error::InvalidEvidence`]: the stake is taken
    /// immediately, and a confiscation that cannot be pointed at its
    /// justification cannot be appealed on evidence either.
    ///
    /// # Order
    ///
    /// Authorization is resolved before the stake is touched, and the stake and
    /// the proof map are written only after every check passes — so a refused
    /// call changes neither the stake nor the replay state.
    ///
    /// # Errors
    /// * [`Error::GovernanceNotConfigured`] — no governance address is set.
    /// * [`Error::NotGovernance`] — `caller` is not the governance address.
    /// * [`Error::InvalidEvidence`] — `proof_ref` or `uri` is empty.
    /// * [`Error::FraudProofAlreadyUsed`] — the proof reference is taken.
    /// * [`Error::InvalidStake`] — `amount <= 0`.
    /// * [`Error::InsufficientBalance`] — `amount` exceeds the stake.
    /// * [`Error::StakeBelowMinimum`] — the remainder would fall under
    ///   `min_stake`.
    /// * [`Error::InvalidAppealWindow`] — the deadline is not representable.
    /// # Proof identity
    ///
    /// `proof_id` is the caller's unique identifier for the underlying fraud
    /// evidence. It must be globally unique within the pool and non-empty; the
    /// stored [`SlashProof`] is what makes the identifier auditable. Reusing one
    /// returns [`Error::FraudProofAlreadyUsed`].
    ///
    /// `reason` remains a `Symbol` and an event topic so consumers can filter by
    /// cause, but it carries **no** replay semantics: two real incidents against
    /// one sentinel can share a reason code and must still be slashable
    /// separately.
    ///
    /// # Amount bounds
    ///
    /// Checked in this order, all before the first write:
    ///
    /// | Bound | Error |
    /// | --- | --- |
    /// | `amount > 0` | [`Error::InvalidSlashAmount`] |
    /// | `amount <= current stake` | [`Error::SlashExceedsStake`] |
    /// | remainder `>= min_stake` | [`Error::StakeBelowMinimum`] |
    ///
    /// The three bounds are distinct conditions with distinct remedies, so each
    /// gets its own error rather than collapsing into one. Because the balance
    /// and the proof map are written only after all three pass, a refused slash
    /// leaves the stake unchanged **and** leaves the identifier unused.
    ///
    /// # Errors
    /// * [`Error::InvalidProofId`] — `proof_id` is empty.
    /// * [`Error::FraudProofAlreadyUsed`] — the identifier was already applied.
    /// * [`Error::InvalidSlashAmount`] — `amount <= 0`.
    /// * [`Error::SlashExceedsStake`] — `amount` exceeds the current stake.
    /// * [`Error::StakeBelowMinimum`] — the remainder would fall under
    ///   `min_stake`.
    /// * [`Error::Unauthorized`] — `admin` is not the configured admin.
    /// # Slash a sentinel's stake
    ///
    /// Requires a configured admin — `require_initialized` first, then
    /// `require_admin` against the stored value — so an unconfigured
    /// deployment can no longer be slashed against by whichever address
    /// happened to authorize the call.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — the pool is not configured.
    /// * [`Error::Unauthorized`] — `admin` is not the configured admin.
    /// * [`Error::InvalidStake`] — `amount <= 0`.
    /// * [`Error::FraudProofAlreadyUsed`] — the `(sentinel, reason)` proof was
    ///   already applied.
    /// * [`Error::InsufficientBalance`] — `amount` exceeds the stake.
    /// * [`Error::StakeBelowMinimum`] — the remainder would fall under
    ///   `min_stake`.
    pub fn slash(
        env: Env,
        caller: Address,
        sentinel: Address,
        amount: i128,
        evidence: SlashEvidence,
        reason: Symbol,
    ) -> Result<(), Error> {
        if evidence.proof_ref.is_empty() || evidence.uri.is_empty() {
            return Err(Error::InvalidEvidence);
        }
        proof_id: String,
        reason: Symbol,
    ) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        if proof_id.is_empty() {
            return Err(Error::InvalidProofId);
        }
        Self::require_initialized(&env)?;

        if amount <= 0 {
            return Err(Error::InvalidSlashAmount);
        }

        caller.require_auth();
        Self::require_governance(&env, &caller)?;

        let proof_ref = evidence.proof_ref.clone();

        let mut records: Map<String, SlashRecord> = env
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        let mut proofs: Map<String, SlashProof> = env
            .storage()
            .instance()
            .get(&DataKey::SlashProofs)
            .unwrap_or_else(|| Map::new(&env));

        if records.contains_key(proof_ref.clone()) {
        if proofs.contains_key(proof_id.clone()) {
            return Err(Error::FraudProofAlreadyUsed);
        }

        let mut stakes: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&DataKey::Stakes)
            .unwrap_or_else(|| Map::new(&env));

        let current = stakes.get(sentinel.clone()).unwrap_or(0);
        if amount > current {
            return Err(Error::SlashExceedsStake);
        }

        let remaining = current
            .checked_sub(amount)
            .ok_or(Error::SlashExceedsStake)?;

        let min_stake = Self::min_stake(env.clone());
        if remaining < min_stake {
            return Err(Error::StakeBelowMinimum);
        }

        let aggregate = Self::total_stake(env.clone());
        let new_aggregate = aggregate
            .checked_sub(amount)
            .ok_or(Error::InsufficientBalance)?;
        let slashed_at = u64::from(env.ledger().sequence());
        let appeal_window = Self::appeal_window(env.clone());
        let appeal_deadline = slashed_at
            .checked_add(appeal_window)
            .ok_or(Error::InvalidAppealWindow)?;

        stakes.set(sentinel.clone(), remaining);
        env.storage().instance().set(&DataKey::Stakes, &stakes);
        env.storage()
            .instance()
            .set(&DataKey::TotalStake, &new_aggregate);

        records.set(
            proof_ref.clone(),
            SlashRecord {
                sentinel: sentinel.clone(),
                reason: reason.clone(),
                amount,
                slashed_at,
                evidence: evidence.clone(),
                appeal_window,
                appeal_deadline,
                appealed: false,
                outcome: SlashOutcome::Pending,
                resolved_at: 0,
            },
        );
        env.storage().instance().set(&DataKey::SlashProofs, &records);
        proofs.set(
            proof_id.clone(),
            SlashProof {
                sentinel: sentinel.clone(),
                reason: reason.clone(),
                amount,
                slashed_at: u64::from(env.ledger().sequence()),
            },
        );
        env.storage().instance().set(&DataKey::SlashProofs, &proofs);

        SlashedEvent {
            sentinel: sentinel.clone(),
            reason,
            proof_ref,
            evidence_uri: evidence.uri,
            evidence_hash: evidence.content_hash,
            amount,
            remaining,
            slashed_at,
            appeal_deadline,
            proof_id,
            amount,
            remaining,
            slashed_at: u64::from(env.ledger().sequence()),
        }
        .publish(&env);

        Ok(())
    }

    /// # Appeal an applied slash
    ///
    /// The appellant may be the slashed sentinel or the governance address;
    /// either is a party to the dispute. Appeals are accepted while
    /// `ledger.sequence() <= appeal_deadline` and refused with
    /// [`Error::AppealWindowClosed`] from the ledger after it.
    ///
    /// The window is copied onto the record when the slash is applied, so
    /// `set_appeal_window` afterwards cannot retroactively close an open window.
    ///
    /// # Errors
    /// * [`Error::UnknownProof`] — no record under `proof_ref`.
    /// * [`Error::AppealWindowClosed`] — the deadline has passed, or the window
    ///   in force was zero.
    /// * [`Error::AlreadyResolved`] — the slash has been resolved.
    /// * [`Error::NotGovernance`] — the appellant is neither the sentinel nor
    ///   governance.
    pub fn appeal_slash(
        env: Env,
        appellant: Address,
        proof_ref: String,
        note: String,
    ) -> Result<(), Error> {
        let mut records: Map<String, SlashRecord> = env
            .storage()
            .instance()
            .get(&DataKey::SlashProofs)
            .unwrap_or_else(|| Map::new(&env));

        let mut record: SlashRecord = records.get(proof_ref.clone()).ok_or(Error::UnknownProof)?;

        appellant.require_auth();

        // The sentinel is a party to the dispute; governance is the other one.
        if appellant != record.sentinel {
            Self::require_governance(&env, &appellant)?;
        }

        if record.outcome != SlashOutcome::Pending {
            return Err(Error::AlreadyResolved);
        }

        let now = u64::from(env.ledger().sequence());
        if record.appeal_window == 0 || now > record.appeal_deadline {
            return Err(Error::AppealWindowClosed);
        }

        record.appealed = true;
        records.set(proof_ref.clone(), record.clone());
        env.storage().instance().set(&DataKey::SlashProofs, &records);

        SlashAppealedEvent {
            sentinel: record.sentinel,
            proof_ref,
            appellant,
            note,
            appealed_at: now,
            appeal_deadline: record.appeal_deadline,
        }
        .publish(&env);

        Ok(())
    }

    /// # Resolve a slash, upholding or reversing it
    ///
    /// Terminal, and **exactly once**: a second call on the same `proof_ref` is
    /// [`Error::AlreadyResolved`], whichever outcome it asks for. Without that
    /// constraint a reversed slash could be reversed again, restoring the same
    /// stake twice.
    ///
    /// A reversal restores `amount` with `checked_add`. An upheld slash leaves
    /// the stake where it is.
    ///
    /// # Errors
    /// * [`Error::GovernanceNotConfigured`] — no governance address is set.
    /// * [`Error::NotGovernance`] — `caller` is not the governance address.
    /// * [`Error::UnknownProof`] — no record under `proof_ref`.
    /// * [`Error::AlreadyResolved`] — the slash is already resolved.
    /// * [`Error::InsufficientBalance`] — the restoration would overflow.
    pub fn resolve_slash(
        env: Env,
        caller: Address,
        proof_ref: String,
        uphold: bool,
    ) -> Result<(), Error> {
        caller.require_auth();
        Self::require_governance(&env, &caller)?;

        let mut records: Map<String, SlashRecord> = env
            .storage()
            .instance()
            .get(&DataKey::SlashProofs)
            .unwrap_or_else(|| Map::new(&env));

        let mut record: SlashRecord = records.get(proof_ref.clone()).ok_or(Error::UnknownProof)?;

        // The check precedes every write, so a refused resolution leaves both
        // the record and the stake untouched.
        if record.outcome != SlashOutcome::Pending {
            return Err(Error::AlreadyResolved);
        }

        let mut stakes: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&DataKey::Stakes)
            .unwrap_or_else(|| Map::new(&env));

        let sentinel = record.sentinel.clone();
        let current = stakes.get(sentinel.clone()).unwrap_or(0);

        // A reversal adds the slashed amount back with `checked_add`, so an
        // overflow is a refusal rather than a wrapped balance. An upholding
        // resolution leaves the balance exactly where the slash put it.
        let restored = if uphold { 0 } else { record.amount };
        let remaining = if uphold {
            current
        } else {
            current
                .checked_add(record.amount)
                .ok_or(Error::InsufficientBalance)?
        };

        stakes.set(sentinel.clone(), remaining);
        env.storage().instance().set(&DataKey::Stakes, &stakes);

        record.outcome = if uphold {
            SlashOutcome::Upheld
        } else {
            SlashOutcome::Reversed
        };
        record.resolved_at = u64::from(env.ledger().sequence());
        records.set(proof_ref.clone(), record);
        env.storage().instance().set(&DataKey::SlashProofs, &records);

        // Append-only, so the audit order is the resolution order (#1093).
        let mut resolved: soroban_sdk::Vec<String> = env
            .storage()
            .instance()
            .get(&DataKey::ResolvedSlashes)
            .unwrap_or_else(|| soroban_sdk::Vec::new(&env));
        resolved.push_back(proof_ref.clone());
        env.storage().instance().set(&DataKey::ResolvedSlashes, &resolved);

        SlashResolvedEvent {
            sentinel,
            proof_ref,
            outcome: if uphold {
                SlashOutcome::Upheld
            } else {
                SlashOutcome::Reversed
            },
            resolver: caller,
            restored,
            remaining,
            resolved_at: u64::from(env.ledger().sequence()),
        }
        .publish(&env);

        Ok(())
    }

    /// The record stored under `proof_ref`, if any.
    ///
    /// The audit view: proof reference, evidence, ledger, appeal state and
    /// outcome, without replaying the event stream.
    pub fn slash_record(env: Env, proof_ref: String) -> Option<SlashRecord> {
        let records: Map<String, SlashRecord> = env
    /// The proof record stored under `proof_id`, if any.
    ///
    /// The counterpart to `slash`'s uniqueness check: an auditor holding an
    /// identifier from an event or an off-chain case file can ask the contract
    /// what it was applied to, for how much, and on which ledger — without
    /// replaying the event stream.
    pub fn slash_proof(env: Env, proof_id: String) -> Option<SlashProof> {
        let proofs: Map<String, SlashProof> = env
            .storage()
            .instance()
            .get(&DataKey::SlashProofs)
            .unwrap_or_else(|| Map::new(&env));

        records.get(proof_ref)
        proofs.get(proof_id)
    }
}

#[contractimpl]
impl SentinelPool {
    /// # Resolved slash history
    ///
    /// Returns up to `limit` resolved slash records starting at `cursor`, in
    /// resolution order. `limit` is capped at [`MAX_RESOLVED_PAGE`]; pass
    /// `cursor + returned_len` to fetch the next page (#1093).
    pub fn resolved_slashes(env: Env, cursor: u32, limit: u32) -> soroban_sdk::Vec<SlashRecord> {
        let ids: soroban_sdk::Vec<String> = env
            .storage()
            .instance()
            .get(&DataKey::ResolvedSlashes)
            .unwrap_or_else(|| soroban_sdk::Vec::new(&env));
        let records: Map<String, SlashRecord> = env
            .storage()
            .instance()
            .get(&DataKey::SlashProofs)
            .unwrap_or_else(|| Map::new(&env));

        let end = cursor
            .saturating_add(limit.min(MAX_RESOLVED_PAGE))
            .min(ids.len());
        let mut page = soroban_sdk::Vec::new(&env);
        let mut i = cursor;
        while i < end {
            if let Some(record) = ids.get(i).and_then(|id| records.get(id)) {
                page.push_back(record);
            }
            i += 1;
        }
        page
    }

    /// # Aggregate eligible stake
    ///
    /// Sums the balances of the supplied sentinels that are eligible at
    /// `at_ledger`. Refuses more than `max` sentinels so the call stays bounded,
    /// and uses checked arithmetic so an overflow is an error (#1096).
    pub fn eligible_stake(
        env: Env,
        sentinels: soroban_sdk::Vec<Address>,
        at_ledger: u32,
        max: u32,
    ) -> Result<i128, Error> {
        if sentinels.len() > max {
            return Err(Error::TooManySentinels);
        }

        let mut total: i128 = 0;
        for sentinel in sentinels.iter() {
            if Self::is_eligible(env.clone(), sentinel.clone(), at_ledger) {
                total = total
                    .checked_add(Self::balance(env.clone(), sentinel))
                    .ok_or(Error::InvalidAmount)?;
            }
        }
        Ok(total)
    }

    /// # Propose a governance change
    ///
    /// Admin-only. Each proposal gets the next id from a monotonically
    /// increasing nonce and replaces any pending one, so an acceptance for an
    /// older proposal can no longer apply (#1097).
    pub fn propose_governance(env: Env, admin: Address, governance: Address) -> Result<u64, Error> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalNonce)
            .unwrap_or(0u64)
            .checked_add(1)
            .ok_or(Error::InvalidAmount)?;
        env.storage().instance().set(&DataKey::ProposalNonce, &id);
        env.storage().instance().set(
            &DataKey::PendingProposal,
            &GovernanceProposal { id, governance },
        );
        Ok(id)
    }

    /// # Accept a governance change
    ///
    /// The proposed address accepts by id. A stale id, or a second acceptance
    /// of the same proposal, is refused with [`Error::StaleProposal`] (#1097).
    pub fn accept_governance(env: Env, governance: Address, proposal_id: u64) -> Result<(), Error> {
        governance.require_auth();

        let pending: GovernanceProposal = env
            .storage()
            .instance()
            .get(&DataKey::PendingProposal)
            .ok_or(Error::StaleProposal)?;
        if pending.id != proposal_id || pending.governance != governance {
            return Err(Error::StaleProposal);
        }

        env.storage().instance().remove(&DataKey::PendingProposal);
        env.storage()
            .instance()
            .set(&DataKey::Governance, &governance);

        GovernanceUpdatedEvent {
            actor: governance.clone(),
            governance,
        }
        .publish(&env);

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events as _, Ledger},
        Env, Event,
    };

    fn proof(env: &Env, text: &str) -> String {
        String::from_str(env, text)
    }

    #[test]
    fn stake_and_balance_persist_across_queries() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &150);

        assert_eq!(client.balance(&sentinel), 150);
        assert_eq!(client.min_stake(), 100);
        assert_eq!(client.threshold(), 2);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn stake_below_required_minimum_is_rejected() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &99);
    }

    #[test]
    fn governance_threshold_updates_are_authorized_and_persisted() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.set_threshold(&admin, &4);

        assert_eq!(client.threshold(), 4);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn unauthorized_threshold_update_fails_without_state_change() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let attacker = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.set_threshold(&attacker, &5);
    }

    #[test]
    fn withdrawals_respect_lock_period_and_minimums() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);

        assert!(client.try_withdraw(&sentinel, &50).is_err());

        env.ledger().with_mut(|l| l.sequence_number = 20);
        client.withdraw(&sentinel, &100);
        assert_eq!(client.balance(&sentinel), 150);

        client.withdraw(&sentinel, &50);
        assert_eq!(client.balance(&sentinel), 100);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn withdrawal_during_lock_period_raises_explicit_error() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);
        client.withdraw(&sentinel, &50);
    }

    #[test]
    fn slashing_records_the_penalty_and_rejects_replay() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_42 = evidence(&env, "case-42");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);
        client.slash(&governance, &sentinel, &50, &case_42, &reason);

        assert_eq!(client.balance(&sentinel), 200);
        assert!(client
            .try_slash(&governance, &sentinel, &10, &case_42, &reason)
            .is_err());
    }

    fn evidence(env: &Env, proof_ref: &str) -> SlashEvidence {
        SlashEvidence {
            proof_ref: String::from_str(env, proof_ref),
            uri: String::from_str(env, "ipfs://kovara/cases"),
            content_hash: Bytes::from_slice(env, &[0xab; 32]),
        }
    }

    // ── CT-46: slashing is restricted to governance ─────────────────────────

    #[test]
    #[should_panic(expected = "Error(Contract, #9)")]
    fn a_non_governance_caller_cannot_apply_a_slash() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);

        // Not even the admin may slash without being governance.
        client.slash(&admin, &sentinel, &50, &evidence(&env, "case-1"), &reason);
    }

    #[test]
    fn a_refused_slash_changes_neither_stake_nor_replay_state() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let attacker = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");
        let case_42 = proof(&env, "case-42");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);
        client.slash(&admin, &sentinel, &50, &case_42, &reason);

        assert!(client
            .try_slash(&attacker, &sentinel, &50, &case_1.clone(), &reason)
            .is_err());
        assert_eq!(client.balance(&sentinel), 250);
        // The proof reference was never consumed, so governance can still use
        // it exactly once.
        assert_eq!(client.slash_record(&case_1.proof_ref), None);

        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);
        assert_eq!(client.balance(&sentinel), 200);
        assert!(client.slash_record(&case_1.proof_ref).is_some());
    }

    #[test]
    fn an_unconfigured_pool_refuses_every_slash_operation() {
        assert!(client
            .try_slash(&admin, &sentinel, &10, &case_42, &reason)
            .is_err());
    }

    // ── CT-39: lock extension policy ────────────────────────────────────────

    #[test]
    fn a_top_up_does_not_extend_a_lock_that_is_still_running() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        // No `initialize`: there is no configured governance to match against.
        client.stake(&sentinel, &250);
        assert_eq!(client.governance(), None);

        // The caller is the only address that could ever be stored, and it is
        // still refused: the lookup has no fallback to the caller.
        assert!(client
            .try_slash(&admin, &sentinel, &50, &case_1.clone(), &reason)
            .is_err());
        assert!(client
            .try_resolve_slash(&admin, &case_1.proof_ref, &true)
            .is_err());
        assert!(client
            .try_appeal_slash(&sentinel, &case_1.proof_ref, &String::from_str(&env, "n"))
            .is_err());

        assert_eq!(client.balance(&sentinel), 250);
        assert_eq!(client.slash_record(&case_1.proof_ref), None);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #10)")]
    fn a_missing_governance_address_has_its_own_error() {

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);

        env.ledger().with_mut(|l| l.sequence_number = 100);
        client.stake(&sentinel, &250);
        assert_eq!(client.unlock_at(&sentinel), Some(110));

        // Top-ups at 105 and 109 — both inside the window.
        env.ledger().with_mut(|l| l.sequence_number = 105);
        client.stake(&sentinel, &10);
        env.ledger().with_mut(|l| l.sequence_number = 109);
        client.stake(&sentinel, &10);

        // The window still ends at 110, not at 119.
        assert_eq!(client.unlock_at(&sentinel), Some(110));
        assert_eq!(client.balance(&sentinel), 270);

        // And the withdrawal boundary is unchanged by the top-ups.
        env.ledger().with_mut(|l| l.sequence_number = 109);
        assert!(client.try_withdraw(&sentinel, &50).is_err());

        env.ledger().with_mut(|l| l.sequence_number = 110);
        client.withdraw(&sentinel, &50);
        assert_eq!(client.balance(&sentinel), 220);
    }

    #[test]
    fn a_top_up_after_expiry_starts_a_fresh_window() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");

        env.mock_all_auths();
        client.stake(&sentinel, &250);
        client.slash(&admin, &sentinel, &50, &evidence(&env, "case-1"), &reason);
    }

    #[test]
    fn governance_can_be_rotated_by_the_admin() {

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);

        env.ledger().with_mut(|l| l.sequence_number = 100);
        client.stake(&sentinel, &250);
        assert_eq!(client.unlock_at(&sentinel), Some(110));

        // Exactly at expiry: the window is over, so this top-up opens a new one.
        env.ledger().with_mut(|l| l.sequence_number = 110);
        client.stake(&sentinel, &10);
        assert_eq!(client.unlock_at(&sentinel), Some(120));

        // The new window is enforced from its own start, not the old one.
        env.ledger().with_mut(|l| l.sequence_number = 115);
        assert!(client.try_withdraw(&sentinel, &50).is_err());

        env.ledger().with_mut(|l| l.sequence_number = 120);
        client.withdraw(&sentinel, &50);
        assert_eq!(client.balance(&sentinel), 220);
    }

    #[test]
    fn a_genesis_stake_is_not_mistaken_for_never_staked() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let successor = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);

        // Only the admin may rotate.
        assert!(client.try_set_governance(&governance, &successor).is_err());
        client.set_governance(&admin, &successor.clone());
        assert_eq!(client.governance(), Some(successor.clone()));

        // The old governance address loses the power immediately.
        assert!(client
            .try_slash(
                &governance,
                &sentinel,
                &50,
                &evidence(&env, "case-1"),
                &reason
            )
            .is_err());
        assert_eq!(client.balance(&sentinel), 250);

        client.slash(&successor, &sentinel, &50, &evidence(&env, "case-2"), &reason);
        assert_eq!(client.balance(&sentinel), 200);
    }

    // ── CT-43: evidence references ──────────────────────────────────────────

    #[test]
    fn a_slash_records_and_republishes_its_evidence() {
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);

        // Ledger 0: `staked_at == 0` is a real value here, not "absent".
        assert_eq!(env.ledger().sequence(), 0);
        client.stake(&sentinel, &250);
        assert_eq!(client.unlock_at(&sentinel), Some(10));

        // A top-up at ledger 3 must keep the genesis window rather than treat
        // it as a first-ever stake and reset the clock to 3.
        env.ledger().with_mut(|l| l.sequence_number = 3);
        client.stake(&sentinel, &10);
        assert_eq!(client.unlock_at(&sentinel), Some(10));

        env.ledger().with_mut(|l| l.sequence_number = 9);
        assert!(client.try_withdraw(&sentinel, &50).is_err());
        env.ledger().with_mut(|l| l.sequence_number = 10);
        client.withdraw(&sentinel, &50);
    }

    #[test]
    fn an_address_that_never_staked_has_no_unlock_ledger() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let stranger = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);

        assert_eq!(client.unlock_at(&stranger), None);
    }

    // ── CT-40: checked lock-period arithmetic ────────────────────────────────

    #[test]
    fn the_lock_period_is_bounded_at_initialization() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        env.mock_all_auths();

        assert!(client.try_initialize(&admin, &100, &0, &2).is_err());
        assert!(client
            .try_initialize(&admin, &100, &(MAX_LOCK_PERIOD + 1), &2)
            .is_err());

        // The largest supported period is accepted and the largest reachable
        // ledger still produces a representable unlock ledger.
        client.initialize(&admin, &100, &MAX_LOCK_PERIOD, &2);

        let sentinel = Address::generate(&env);
        env.ledger().with_mut(|l| l.sequence_number = u32::MAX);
        client.stake(&sentinel, &250);

        // u32::MAX + MAX_LOCK_PERIOD is representable in u64, so the check
        // passes and the window is real rather than saturated.
        let expected = u64::from(u32::MAX) + MAX_LOCK_PERIOD;
        assert_eq!(client.unlock_at(&sentinel), Some(expected));

        env.ledger().with_mut(|l| l.sequence_number = u32::MAX);
        assert!(client.try_withdraw(&sentinel, &50).is_err());
    }

    #[test]
    fn a_lock_window_that_would_overflow_is_reported_not_saturated() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &MAX_LOCK_PERIOD, &2);

        let sentinel = Address::generate(&env);
        let overflowed = u64::MAX - (MAX_LOCK_PERIOD - 1);

        // Write the window start directly so the test can reach a ledger the
        // host could never set through `l.sequence_number`.
        env.as_contract(&contract_id, || {
            let mut staked_at: Map<Address, u64> = env
                .storage()
                .instance()
                .get(&DataKey::StakedAt)
                .unwrap_or_else(|| Map::new(&env));
            staked_at.set(sentinel.clone(), overflowed);
            env.storage().instance().set(&DataKey::StakedAt, &staked_at);

            let mut stakes: Map<Address, i128> = env
                .storage()
                .instance()
                .get(&DataKey::Stakes)
                .unwrap_or_else(|| Map::new(&env));
            stakes.set(sentinel.clone(), 250);
            env.storage().instance().set(&DataKey::Stakes, &stakes);
        });

        // `overflowed + MAX_LOCK_PERIOD` exceeds `u64::MAX`.
        assert!(client.try_unlock_at(&sentinel).is_err());
        assert!(client.try_withdraw(&sentinel, &50).is_err());
        // Balance preserved by both refusals.
        assert_eq!(client.balance(&sentinel), 250);
    }

    // ── CT-41: explicit slash amount bounds ──────────────────────────────────

    #[test]
    #[should_panic(expected = "Error(Contract, #10)")]
    fn a_zero_slash_amount_is_rejected_with_its_own_error() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.set_appeal_window(&admin, &100);
        client.stake(&sentinel, &250);

        env.ledger().with_mut(|l| l.sequence_number = 500);
        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);

        // The whole record, including the evidence, is readable afterwards.
        let record = client.slash_record(&case_1.proof_ref).unwrap();
        assert_eq!(record.sentinel, sentinel);
        assert_eq!(record.reason, reason);
        assert_eq!(record.amount, 50);
        assert_eq!(record.slashed_at, 500);
        assert_eq!(record.appeal_deadline, 600);
        assert_eq!(record.evidence, case_1);
        assert!(!record.appealed);
        assert_eq!(record.outcome, SlashOutcome::Pending);
        assert_eq!(record.resolved_at, 0);
    }

    #[test]
    fn a_slash_without_evidence_is_refused() {
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.stake(&sentinel, &250);
        client.slash(&admin, &sentinel, &0, &proof(&env, "case-1"), &reason);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #11)")]
    fn a_slash_larger_than_the_stake_is_rejected_with_its_own_error() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.stake(&sentinel, &250);
        client.slash(
            &admin,
            &sentinel,
            &251,
            &proof(&env, "case-1"),
            &reason,
        );
    }

    #[test]
    fn a_refused_slash_changes_neither_stake_nor_proof_state() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);

        let no_ref = SlashEvidence {
            proof_ref: String::from_str(&env, ""),
            uri: String::from_str(&env, "ipfs://kovara/cases"),
            content_hash: Bytes::from_slice(&env, &[0xab; 32]),
        };
        let no_uri = SlashEvidence {
            proof_ref: String::from_str(&env, "case-1"),
            uri: String::from_str(&env, ""),
            content_hash: Bytes::from_slice(&env, &[0xab; 32]),
        };

        assert!(client
            .try_slash(&governance, &sentinel, &50, &no_ref, &reason)
            .is_err());
        assert!(client
            .try_slash(&governance, &sentinel, &50, &no_uri, &reason)
            .is_err());
        assert_eq!(client.balance(&sentinel), 250);
        assert_eq!(
            client.slash_record(&String::from_str(&env, "case-1")),
            None
        );
    }

    // ── CT-44: bounded appeal window ────────────────────────────────────────

    #[test]
    fn an_appeal_is_accepted_up_to_the_deadline_and_refused_after_it() {
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = proof(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.stake(&sentinel, &250);

        // Every distinct refusal, against the same identifier.
        assert!(client
            .try_slash(&admin, &sentinel, &0, &case_1, &reason)
            .is_err());
        assert!(client
            .try_slash(&admin, &sentinel, &-50, &case_1, &reason)
            .is_err());
        assert!(client
            .try_slash(&admin, &sentinel, &i128::MIN, &case_1, &reason)
            .is_err());
        assert!(client
            .try_slash(&admin, &sentinel, &1_000, &case_1, &reason)
            .is_err());
        assert!(client
            .try_slash(&admin, &sentinel, &i128::MAX, &case_1, &reason)
            .is_err());
        // Would leave the sentinel under the minimum.
        assert!(client
            .try_slash(&admin, &sentinel, &200, &case_1, &reason)
            .is_err());
        // Empty identifier.
        assert!(client
            .try_slash(&admin, &sentinel, &50, &proof(&env, ""), &reason)
            .is_err());

        assert_eq!(client.balance(&sentinel), 250);
        assert_eq!(client.slash_proof(&case_1), None);

        // Because none of those refusals consumed the identifier, it is still
        // usable exactly once.
        client.slash(&admin, &sentinel, &50, &case_1, &reason);
        assert_eq!(client.balance(&sentinel), 200);
        assert!(client.slash_proof(&case_1).is_some());
    }

    #[test]
    fn a_slash_of_exactly_the_available_stake_is_refused_by_the_floor() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");
        let case_2 = evidence(&env, "case-2");
        let case_3 = evidence(&env, "case-3");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.set_appeal_window(&admin, &100);
        client.stake(&sentinel, &500);

        env.ledger().with_mut(|l| l.sequence_number = 1_000);
        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);
        client.slash(&governance, &sentinel, &50, &case_2.clone(), &reason);
        client.slash(&governance, &sentinel, &50, &case_3.clone(), &reason);
        // All three deadlines are 1_100.

        // One ledger inside the window.
        env.ledger().with_mut(|l| l.sequence_number = 1_099);
        client.appeal_slash(
            &sentinel,
            &case_1.proof_ref,
            &String::from_str(&env, "mislabelled"),
        );
        assert!(client
            .slash_record(&case_1.proof_ref)
            .unwrap()
            .appealed);

        // Exactly on the deadline: still open.
        env.ledger().with_mut(|l| l.sequence_number = 1_100);
        client.appeal_slash(
            &sentinel,
            &case_2.proof_ref,
            &String::from_str(&env, "on_time"),
        );
        assert!(client
            .slash_record(&case_2.proof_ref)
            .unwrap()
            .appealed);

        // One ledger later: closed.
        env.ledger().with_mut(|l| l.sequence_number = 1_101);
        assert!(client
            .try_appeal_slash(
                &sentinel,
                &case_3.proof_ref,
                &String::from_str(&env, "too_late")
            )
            .is_err());
        assert!(!client
            .slash_record(&case_3.proof_ref)
            .unwrap()
            .appealed);
    }

    #[test]
    fn an_appeal_exactly_on_the_deadline_is_accepted() {
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.stake(&sentinel, &250);

        // Exactly the balance is within the "exceeds stake" bound but breaks the
        // minimum-stake floor, which is the error that must surface.
        assert!(client
            .try_slash(&admin, &sentinel, &250, &proof(&env, "case-1"), &reason)
            .is_err());
        assert_eq!(client.balance(&sentinel), 250);

        // The largest slash the floor allows.
        client.slash(
            &admin,
            &sentinel,
            &150,
            &proof(&env, "case-2"),
            &reason,
        );
        assert_eq!(client.balance(&sentinel), 100);
    }

    // ── CT-42: collision-resistant proof identity ───────────────────────────

    #[test]
    fn two_incidents_sharing_a_reason_code_are_both_slashable() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.set_appeal_window(&admin, &100);
        client.stake(&sentinel, &250);

        env.ledger().with_mut(|l| l.sequence_number = 200);
        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);
        assert_eq!(
            client.slash_record(&case_1.proof_ref)
                .unwrap()
                .appeal_deadline,
            300
        );

        env.ledger().with_mut(|l| l.sequence_number = 300);
        client.appeal_slash(
            &sentinel,
            &case_1.proof_ref,
            &String::from_str(&env, "right_on_time"),
        );

        let record = client.slash_record(&case_1.proof_ref).unwrap();
        assert!(record.appealed);
        assert_eq!(record.outcome, SlashOutcome::Pending);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #12)")]
    fn an_appeal_after_the_deadline_is_refused() {
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.stake(&sentinel, &1_000);

        // Same sentinel, same reason, different evidence: the old
        // `(sentinel, reason)` key refused the second one.
        client.slash(&admin, &sentinel, &100, &proof(&env, "case-2024-11"), &reason);
        client.slash(&admin, &sentinel, &200, &proof(&env, "case-2025-03"), &reason);

        assert_eq!(client.balance(&sentinel), 700);
        assert!(client.slash_proof(&proof(&env, "case-2024-11")).is_some());
        assert!(client.slash_proof(&proof(&env, "case-2025-03")).is_some());
    }

    #[test]
    fn the_proof_identifier_alone_bounds_replay() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.set_appeal_window(&admin, &100);
        client.stake(&sentinel, &250);

        env.ledger().with_mut(|l| l.sequence_number = 200);
        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);

        env.ledger().with_mut(|l| l.sequence_number = 301);
        client.appeal_slash(&sentinel, &case_1.proof_ref, &String::from_str(&env, "late"));
    }

    #[test]
    fn shortening_the_window_does_not_close_an_already_open_appeal() {
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let other_reason = Symbol::new(&env, "late_report");

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.stake(&alice, &400);
        client.stake(&bob, &400);

        let case_1 = proof(&env, "case-1");

        client.slash(&admin, &alice, &100, &case_1.clone(), &reason);

        // A different sentinel: still refused. Replay protection is on the
        // identifier, not on the (sentinel, reason) pair — otherwise the same
        // evidence could be used against a second address.
        assert!(client
            .try_slash(&admin, &bob, &100, &case_1, &reason)
            .is_err());
        // A different reason: still refused, for the same reason.
        assert!(client
            .try_slash(&admin, &alice, &100, &case_1, &other_reason)
            .is_err());
        // A different sentinel *and* a different reason: still refused.
        assert!(client
            .try_slash(&admin, &bob, &100, &case_1, &other_reason)
            .is_err());

        assert_eq!(client.balance(&alice), 300);
        assert_eq!(client.balance(&bob), 400);
    }

    #[test]
    fn a_proof_record_describes_what_it_was_applied_to() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.set_appeal_window(&admin, &1_000);
        client.stake(&sentinel, &250);

        env.ledger().with_mut(|l| l.sequence_number = 100);
        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);
        assert_eq!(
            client.slash_record(&case_1.proof_ref)
                .unwrap()
                .appeal_deadline,
            1_100
        );

        // The admin shortens the window *after* the slash.
        client.set_appeal_window(&admin, &1);

        // The deadline recorded on the slash is unchanged, so the appeal the
        // sentinel was already entitled to still lands.
        env.ledger().with_mut(|l| l.sequence_number = 1_050);
        client.appeal_slash(&sentinel, &case_1.proof_ref, &String::from_str(&env, "still_open"));

        // A slash applied under the new, shorter window closes quickly.
        let case_2 = evidence(&env, "case-2");
        env.ledger().with_mut(|l| l.sequence_number = 1_100);
        client.slash(&governance, &sentinel, &50, &case_2.clone(), &reason);
        assert_eq!(
            client.slash_record(&case_2.proof_ref)
                .unwrap()
                .appeal_deadline,
            1_101
        );
        env.ledger().with_mut(|l| l.sequence_number = 1_102);
        assert!(client
            .try_appeal_slash(&sentinel, &case_2.proof_ref, &String::from_str(&env, "late"))
            .is_err());
    }

    #[test]
    fn the_appeal_window_is_bounded_and_admin_only() {
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = proof(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.stake(&sentinel, &250);

        assert_eq!(client.slash_proof(&case_1), None);

        env.ledger().with_mut(|l| l.sequence_number = 77);
        client.slash(&admin, &sentinel, &50, &case_1.clone(), &reason);

        assert_eq!(
            client.slash_proof(&case_1),
            Some(SlashProof {
                sentinel: sentinel.clone(),
                reason,
                amount: 50,
                slashed_at: 77,
            })
        );

        // Unknown identifiers report `None` rather than failing.
        assert_eq!(client.slash_proof(&proof(&env, "case-404")), None);
    }

    #[test]
    fn an_unauthorized_slash_neither_moves_stake_nor_burns_the_proof() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let attacker = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = proof(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.stake(&sentinel, &250);

        assert!(client
            .try_slash(&attacker, &sentinel, &50, &case_1.clone(), &reason)
            .is_err());
        assert_eq!(client.balance(&sentinel), 250);
        assert_eq!(client.slash_proof(&case_1), None);

        // The failed attempt did not consume the identifier.
        client.slash(&admin, &sentinel, &50, &case_1.clone(), &reason);
        assert_eq!(client.balance(&sentinel), 200);
    }

    // ── CT-31: initialization safeguards ────────────────────────────────────

    #[test]
    fn a_rejected_initialization_leaves_the_pool_uninitialized() {
    // ── CT-35: stake event details ──────────────────────────────────────────

    #[test]
    fn a_stake_event_carries_the_resulting_balance_and_its_ledger() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let attacker = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);

        assert_eq!(client.appeal_window(), DEFAULT_APPEAL_WINDOW_LEDGERS);

        assert!(client.try_set_appeal_window(&attacker, &10).is_err());
        assert!(client.try_set_appeal_window(&admin, &0).is_err());
        assert!(client
            .try_set_appeal_window(&admin, &(MAX_APPEAL_WINDOW_LEDGERS + 1))
            .is_err());
        assert_eq!(client.appeal_window(), DEFAULT_APPEAL_WINDOW_LEDGERS);

        client.set_appeal_window(&admin, &MAX_APPEAL_WINDOW_LEDGERS);
        assert_eq!(client.appeal_window(), MAX_APPEAL_WINDOW_LEDGERS);
    }

    #[test]
    fn an_unknown_proof_cannot_be_appealed_or_resolved() {

        env.mock_all_auths();

        assert!(!client.is_initialized());

        // Non-positive minimum stake.
        assert!(client.try_initialize(&admin, &0, &10, &2).is_err());
        assert!(!client.is_initialized());

        // Zero lock period.
        assert!(client.try_initialize(&admin, &100, &0, &2).is_err());
        assert!(!client.is_initialized());

        // Lock period beyond MAX_LOCK_PERIOD.
        assert!(client
            .try_initialize(&admin, &100, &(MAX_LOCK_PERIOD + 1), &2)
            .is_err());
        assert!(!client.is_initialized());

        // Zero quorum threshold.
        assert!(client.try_initialize(&admin, &100, &10, &0).is_err());
        assert!(!client.is_initialized());

        // Nothing partial leaked into any configuration slot.
        assert_eq!(client.min_stake(), 0);
        assert_eq!(client.threshold(), 0);

        // The largest supported lock period is accepted, so the bound above is
        // a real limit and not an off-by-one.
        client.initialize(&admin, &100, &MAX_LOCK_PERIOD, &2);
        assert!(client.is_initialized());
        assert_eq!(client.threshold(), 2);
    }

    #[test]
    fn re_initialization_is_refused() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let missing = String::from_str(&env, "case-404");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);

        assert!(client
            .try_appeal_slash(&sentinel, &missing, &String::from_str(&env, "n"))
            .is_err());
        assert!(client.try_resolve_slash(&governance, &missing, &true).is_err());
        assert_eq!(client.slash_record(&missing), None);
    }

    // ── CT-45: reversible resolution, exactly once ──────────────────────────

    #[test]
    fn an_upheld_slash_is_terminal_and_leaves_the_stake_removed() {
        let other = Address::generate(&env);

        env.mock_all_auths();

        client.initialize(&admin, &100, &10, &2);
        assert!(client.try_initialize(&other, &999, &999, &9).is_err());

        // The original configuration survives the refused call.
        assert_eq!(client.min_stake(), 100);
        assert_eq!(client.threshold(), 2);
    }

    // ── CT-32: authorized threshold updates ─────────────────────────────────

    #[test]
    fn zero_threshold_is_refused_without_touching_storage() {
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);

        env.ledger().with_mut(|l| l.sequence_number = 7);
        client.stake(&sentinel, &150);

        // The whole payload is asserted: the event names the increment, the
        // balance *after* it, and the ledger the lock runs from.
        let first = StakedEvent {
            sentinel: sentinel.clone(),
            amount: 150,
            total: 150,
            staked_at: 7,
        };
        assert_eq!(
            env.events().all().filter_by_contract(&contract_id),
            [first.to_xdr(&env, &contract_id)]
        );

        // A top-up reports the balance after *that* deposit, not the delta.
        env.ledger().with_mut(|l| l.sequence_number = 9);
        client.stake(&sentinel, &50);

        let second = StakedEvent {
            sentinel: sentinel.clone(),
            amount: 50,
            total: 200,
            staked_at: 9,
        };
        assert_eq!(
            env.events().all().filter_by_contract(&contract_id),
            [first.to_xdr(&env, &contract_id), second.to_xdr(&env, &contract_id)]
        );
        assert_eq!(client.balance(&sentinel), 200);
    }

    // ── CT-36: the minimum-stake floor on withdrawal ────────────────────────

    #[test]
    fn a_partial_withdrawal_may_reach_the_floor_but_never_cross_it() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);
        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);

        env.ledger().with_mut(|l| l.sequence_number = 20);
        client.resolve_slash(&governance, &case_1.proof_ref, &true);

        let record = client.slash_record(&case_1.proof_ref).unwrap();
        assert_eq!(record.outcome, SlashOutcome::Upheld);
        assert_eq!(record.resolved_at, 20);
        assert_eq!(client.balance(&sentinel), 200);

        // Upholding again is refused; so is reversing afterwards.
        assert!(client
            .try_resolve_slash(&governance, &case_1.proof_ref, &true)
            .is_err());
        assert!(client
            .try_resolve_slash(&governance, &case_1.proof_ref, &false)
            .is_err());
        assert_eq!(client.balance(&sentinel), 200);
    }

    #[test]
    fn a_reversed_slash_restores_the_stake_exactly_once() {

        env.mock_all_auths();

        client.initialize(&admin, &100, &10, &2);
        assert!(client.try_set_threshold(&admin, &0).is_err());

        assert_eq!(client.threshold(), 2);
    }

    #[test]
    fn threshold_update_on_an_uninitialized_pool_is_refused() {
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.stake(&sentinel, &250);
        env.ledger().with_mut(|l| l.sequence_number = 20);

        // Exactly to the floor: allowed.
        client.withdraw(&sentinel, &150);
        assert_eq!(client.balance(&sentinel), 100);

        // One unit below the floor: refused, balance preserved.
        assert!(client.try_withdraw(&sentinel, &1).is_err());
        assert_eq!(client.balance(&sentinel), 100);

        // The whole balance: refused too — exiting the set is a lifecycle
        // event, not an arithmetic side effect.
        assert!(client.try_withdraw(&sentinel, &100).is_err());
        assert_eq!(client.balance(&sentinel), 100);
    }

    #[test]
    fn the_floor_is_enforced_on_the_way_in_as_well() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);
        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);
        assert_eq!(client.balance(&sentinel), 200);

        client.resolve_slash(&governance, &case_1.proof_ref, &false);

        let record = client.slash_record(&case_1.proof_ref).unwrap();
        assert_eq!(record.outcome, SlashOutcome::Reversed);
        assert_eq!(client.balance(&sentinel), 250);

        // The restore cannot be replayed.
        assert!(client
            .try_resolve_slash(&governance, &case_1.proof_ref, &false)
            .is_err());
        assert!(client
            .try_resolve_slash(&governance, &case_1.proof_ref, &true)
            .is_err());
        assert_eq!(client.balance(&sentinel), 250);
    }

    #[test]
    fn an_appeal_does_not_by_itself_restore_the_stake() {
        let attacker = Address::generate(&env);

        env.mock_all_auths();

        // The caller is the *only* address that could ever be stored, and it is
        // still refused: there is no configured admin to match against.
        assert!(!client.is_initialized());
        assert!(client.try_set_threshold(&admin, &7).is_err());
        assert!(client.try_set_threshold(&attacker, &7).is_err());

        assert_eq!(client.threshold(), 0);
    }

    #[test]
    fn min_stake_updates_share_the_same_authorization_rules() {
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);

        // The first stake must clear the floor on its own.
        assert!(client.try_stake(&sentinel, &99).is_err());
        assert_eq!(client.balance(&sentinel), 0);

        client.stake(&sentinel, &100);
        assert_eq!(client.balance(&sentinel), 100);

        // A top-up that is individually small is fine: the *resulting* balance
        // is what has to clear the floor, not the increment.
        client.stake(&sentinel, &1);
        assert_eq!(client.balance(&sentinel), 101);
    }

    #[test]
    fn raising_the_floor_above_an_existing_balance_is_refused_on_withdrawal() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let attacker = Address::generate(&env);

        env.mock_all_auths();

        client.initialize(&admin, &100, &10, &2);

        assert!(client.try_set_min_stake(&admin, &0).is_err());
        assert!(client.try_set_min_stake(&admin, &-5).is_err());
        assert!(client.try_set_min_stake(&attacker, &5).is_err());
        assert_eq!(client.min_stake(), 100);

        client.set_min_stake(&admin, &250);
        assert_eq!(client.min_stake(), 250);
    }

    // ── CT-33: checked stake arithmetic ─────────────────────────────────────

    #[test]
    fn stake_overflow_is_refused_and_leaves_the_balance_untouched() {
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.stake(&sentinel, &150);
        client.set_min_stake(&admin, &200);

        env.ledger().with_mut(|l| l.sequence_number = 20);

        // The sentinel is already under the new floor, so every withdrawal —
        // including a zero-change one — is refused and the balance is intact.
        assert!(client.try_withdraw(&sentinel, &1).is_err());
        assert_eq!(client.balance(&sentinel), 150);
    }

    // ── CT-37: overflow-safe withdrawal accounting ──────────────────────────

    #[test]
    fn an_excessive_withdrawal_preserves_the_balance() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();

        client.initialize(&admin, &100, &10, &2);
        client.stake(&sentinel, &1_000);

        // `1_000 + i128::MAX` overflows.
        assert!(client.try_stake(&sentinel, &i128::MAX).is_err());
        assert_eq!(client.balance(&sentinel), 1_000);

        // The balance is unchanged, so the same overflow is still the answer.
        assert!(client.try_stake(&sentinel, &i128::MAX).is_err());
        assert_eq!(client.balance(&sentinel), 1_000);
    }

    #[test]
    fn the_largest_representable_stake_is_accepted_exactly_once() {
        let stranger = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.stake(&sentinel, &250);
        env.ledger().with_mut(|l| l.sequence_number = 20);

        // More than the balance.
        assert!(client.try_withdraw(&sentinel, &251).is_err());
        assert_eq!(client.balance(&sentinel), 250);

        // `i128::MAX` against a small balance.
        assert!(client.try_withdraw(&sentinel, &i128::MAX).is_err());
        assert_eq!(client.balance(&sentinel), 250);

        // Zero and negative amounts.
        assert!(client.try_withdraw(&sentinel, &0).is_err());
        assert!(client.try_withdraw(&sentinel, &-250).is_err());
        assert!(client.try_withdraw(&sentinel, &i128::MIN).is_err());
        assert_eq!(client.balance(&sentinel), 250);

        // An address that never staked has nothing to withdraw.
        assert!(client.try_withdraw(&stranger, &1).is_err());
        assert_eq!(client.balance(&stranger), 0);
    }

    #[test]
    fn a_refused_withdrawal_emits_nothing() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);
        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);

        client.appeal_slash(&sentinel, &case_1.proof_ref, &String::from_str(&env, "dispute"));

        let record = client.slash_record(&case_1.proof_ref).unwrap();
        assert!(record.appealed);
        assert_eq!(record.outcome, SlashOutcome::Pending);
        // The slash stands until governance resolves it.
        assert_eq!(client.balance(&sentinel), 200);
    }

    #[test]
    fn a_resolved_slash_can_no_longer_be_appealed() {
        let sentinel = Address::generate(&env);

        env.mock_all_auths();

        client.initialize(&admin, &100, &10, &2);
        client.stake(&sentinel, &i128::MAX);

        assert_eq!(client.balance(&sentinel), i128::MAX);
        // Replaying the same maximal deposit is the overflow case.
        assert!(client.try_stake(&sentinel, &i128::MAX).is_err());
        assert_eq!(client.balance(&sentinel), i128::MAX);
    }

    #[test]
    fn a_zero_or_negative_deposit_never_creates_a_stake() {
        client.initialize(&admin, &100, &10, &2);
        client.stake(&sentinel, &250);
        env.ledger().with_mut(|l| l.sequence_number = 20);

        let before = env.events().all().events().len();
        assert!(client.try_withdraw(&sentinel, &250).is_err());
        assert!(client.try_withdraw(&sentinel, &0).is_err());
        assert_eq!(env.events().all().events().len(), before);
        assert_eq!(client.balance(&sentinel), 250);

        // The accepted withdrawal does publish.
        client.withdraw(&sentinel, &50);
        assert_eq!(env.events().all().events().len(), before + 1);
    }

    // ── CT-38: stake query methods ──────────────────────────────────────────

    #[test]
    fn stake_of_reports_the_full_position_without_writing() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);
        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);
        client.resolve_slash(&governance, &case_1.proof_ref, &true);

        // Still inside the appeal window, but the record is terminal.
        assert!(client
            .try_appeal_slash(&sentinel, &case_1.proof_ref, &String::from_str(&env, "late"))
            .is_err());
    }

    #[test]
    fn governance_may_appeal_as_the_counterparty() {
        let sentinel = Address::generate(&env);

        env.mock_all_auths();

        client.initialize(&admin, &100, &10, &2);

        assert!(client.try_stake(&sentinel, &0).is_err());
        assert!(client.try_stake(&sentinel, &-1).is_err());
        assert_eq!(client.balance(&sentinel), 0);
    }

    // ── CT-34: an initialized pool is a precondition ────────────────────────

    #[test]
    #[should_panic(expected = "Error(Contract, #9)")]
    fn staking_before_initialization_is_refused() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        assert!(!client.is_initialized());
        client.stake(&sentinel, &500);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #9)")]
    fn withdrawing_before_initialization_is_refused() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.withdraw(&sentinel, &100);
    }

    #[test]
    fn slash_before_initialization_claims_no_fraud_proof() {
        let stranger = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);

        env.ledger().with_mut(|l| l.sequence_number = 5);
        client.stake(&sentinel, &250);

        let before = env.events().all().events().len();

        // Locked: 5 + 10 = 15, queried at ledger 6.
        env.ledger().with_mut(|l| l.sequence_number = 6);
        let locked = client.stake_of(&sentinel);
        assert_eq!(locked.amount, 250);
        assert_eq!(locked.staked_at, 5);
        assert_eq!(locked.unlock_at, 15);
        assert!(!locked.unlocked);

        // Exactly at the unlock ledger the lock has elapsed.
        env.ledger().with_mut(|l| l.sequence_number = 15);
        assert!(client.stake_of(&sentinel).unlocked);

        // An address that never staked is the zero record, not an error.
        let none = client.stake_of(&stranger);
        assert_eq!(none.amount, 0);
        assert_eq!(none.staked_at, 0);
        assert_eq!(none.unlock_at, 0);
        assert!(none.unlocked);

        // Reads are reads: no events, no storage drift.
        assert_eq!(env.events().all().events().len(), before);
        assert_eq!(client.balance(&sentinel), 250);
    }

    #[test]
    fn stake_of_tracks_the_lock_across_a_top_up() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let stranger = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &250);
        client.slash(&governance, &sentinel, &50, &case_1.clone(), &reason);

        client.appeal_slash(&governance, &case_1.proof_ref, &String::from_str(&env, "ours"));

        // A third party is a party to nothing.
        assert!(client
            .try_appeal_slash(&stranger, &case_1.proof_ref, &String::from_str(&env, "nosy"))
            .is_err());
    }

    #[test]
    fn a_reversal_that_would_overflow_is_refused_rather_than_wrapping() {
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);

        env.ledger().with_mut(|l| l.sequence_number = 5);
        client.stake(&sentinel, &250);

        env.ledger().with_mut(|l| l.sequence_number = 8);
        client.stake(&sentinel, &50);

        assert_eq!(client.staked_at(&sentinel), 8);
        let position = client.stake_of(&sentinel);
        assert_eq!(position.amount, 300);
        assert_eq!(position.staked_at, 8);
        assert_eq!(position.unlock_at, 18);
    }

    #[test]
    fn total_active_stake_folds_every_sentinel() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");
        let case_1 = evidence(&env, "case-1");

        env.mock_all_auths();
        client.initialize(&admin, &governance, &100, &10, &2);
        client.stake(&sentinel, &i128::MAX);
        client.slash(&governance, &sentinel, &100, &case_1.clone(), &reason);
        assert_eq!(client.balance(&sentinel), i128::MAX - 100);

        // Top the balance back up to the ceiling while the slash is unresolved.
        client.stake(&sentinel, &100);
        assert_eq!(client.balance(&sentinel), i128::MAX);

        // Restoring the slashed 100 would overflow, so the reversal is refused.
        assert!(client
            .try_resolve_slash(&governance, &case_1.proof_ref, &false)
            .is_err());
        assert_eq!(client.balance(&sentinel), i128::MAX);

        // The refusal left the record unresolved, so it is not half-resolved.
        let record = client.slash_record(&case_1.proof_ref).unwrap();
        assert_eq!(record.outcome, SlashOutcome::Pending);
        assert_eq!(record.resolved_at, 0);

        // Upholding leaves the balance alone and still resolves cleanly.
        client.resolve_slash(&governance, &case_1.proof_ref, &true);
        assert_eq!(client.balance(&sentinel), i128::MAX);
        assert_eq!(
            client.slash_record(&case_1.proof_ref)
                .unwrap()
                .outcome,
            SlashOutcome::Upheld
        );
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");

        env.mock_all_auths();
        assert!(client.try_slash(&admin, &sentinel, &10, &reason).is_err());

        // The refused slash did not burn the proof: after a correct
        // initialization the same proof is still usable exactly once.
        client.initialize(&admin, &100, &10, &2);
        client.stake(&sentinel, &250);
        client.slash(&admin, &sentinel, &50, &reason);
        assert_eq!(client.balance(&sentinel), 200);
        assert!(client.try_slash(&admin, &sentinel, &10, &reason).is_err());
    }

    #[test]
    fn initialization_unblocks_every_entry_point() {
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let carol = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);

        // An empty pool totals zero, not an error.
        assert_eq!(client.total_active_stake(), 0);

        client.stake(&alice, &250);
        assert_eq!(client.total_active_stake(), 250);

        client.stake(&bob, &300);
        client.stake(&carol, &100);
        assert_eq!(client.total_active_stake(), 650);

        // A withdrawal only counts once it clears both the lock and the floor.
        env.ledger().with_mut(|l| l.sequence_number = 20);
        assert!(client.try_withdraw(&alice, &200).is_err());
        assert_eq!(client.total_active_stake(), 650);

        client.withdraw(&alice, &150);
        assert_eq!(client.total_active_stake(), 500);

        // A slash is a decrease in the total too.
        let reason = Symbol::new(&env, "fraudulent_submission");
        client.slash(&admin, &bob, &50, &reason);
        assert_eq!(client.total_active_stake(), 450);

        let before = env.events().all().events().len();
        assert_eq!(client.total_active_stake(), 450);
        assert_eq!(env.events().all().events().len(), before);
    }

    #[test]
    fn total_active_stake_saturates_instead_of_wrapping() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();

        assert!(client.try_stake(&sentinel, &250).is_err());

        client.initialize(&admin, &100, &10, &2);

        client.stake(&sentinel, &250);
        assert_eq!(client.balance(&sentinel), 250);

        env.ledger().with_mut(|l| l.sequence_number = 20);
        client.withdraw(&sentinel, &100);
        assert_eq!(client.balance(&sentinel), 150);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);

        client.stake(&alice, &i128::MAX);
        client.stake(&bob, &100);

        // A sum that cannot be represented reports the ceiling, never a
        // negative total.
        assert_eq!(client.total_active_stake(), i128::MAX);
    }

    // ── CT-47: the pool-wide aggregate ──────────────────────────────────────

    #[test]
    fn the_aggregate_tracks_stake_withdrawals_and_slashes() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);

        // An empty pool totals zero, not an error.
        assert_eq!(client.total_stake(), 0);

        client.stake(&alice, &250);
        assert_eq!(client.total_stake(), 250);

        client.stake(&bob, &300);
        client.stake(&alice, &50);
        assert_eq!(client.total_stake(), 600);

        env.ledger().with_mut(|l| l.sequence_number = 20);
        client.withdraw(&alice, &150);
        assert_eq!(client.total_stake(), 450);

        let reason = Symbol::new(&env, "fraudulent_submission");
        client.slash(&admin, &bob, &50, &reason);
        assert_eq!(client.total_stake(), 400);
    }

    #[test]
    fn the_aggregate_never_disagrees_with_the_balances() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let carol = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);

        client.stake(&alice, &250);
        client.stake(&bob, &400);

        env.ledger().with_mut(|l| l.sequence_number = 20);
        client.withdraw(&alice, &50);

        // The invariant, spelled out: the total is the sum of the balances.
        assert_eq!(
            client.total_stake(),
            client.balance(&alice) + client.balance(&bob) + client.balance(&carol)
        );

        // A refused withdrawal moves neither side of the equality.
        assert!(client.try_withdraw(&alice, &i128::MAX).is_err());
        assert_eq!(
            client.total_stake(),
            client.balance(&alice) + client.balance(&bob) + client.balance(&carol)
        );
        assert_eq!(client.total_stake(), 600);
    }

    #[test]
    fn a_refused_stake_leaves_the_aggregate_untouched() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.stake(&sentinel, &1_000);

        // Overflow of the balance.
        assert!(client.try_stake(&sentinel, &i128::MAX).is_err());
        assert_eq!(client.total_stake(), 1_000);

        // Below the floor.
        assert!(client.try_stake(&sentinel, &1).is_err());
        assert_eq!(client.total_stake(), 1_000);

        assert_eq!(client.balance(&sentinel), 1_000);
    }

    #[test]
    fn the_aggregate_saturates_the_balance_it_summarizes() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);

        client.stake(&alice, &i128::MAX);
        assert_eq!(client.total_stake(), i128::MAX);

        // A second deposit cannot be added to the aggregate: refused, and the
        // balance is untouched rather than wrapped negative.
        assert!(client.try_stake(&bob, &100).is_err());
        assert_eq!(client.total_stake(), i128::MAX);
        assert_eq!(client.balance(&bob), 0);
    }

    // ── CT-48: eligibility query ────────────────────────────────────────────

    #[test]
    fn eligibility_is_the_floor_the_lock_and_the_deregistration() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);

        // Never staked: not eligible.
        assert!(!client.is_eligible(&sentinel, &0));

        env.ledger().with_mut(|l| l.sequence_number = 5);
        client.stake(&sentinel, &250);

        // Funded but still locked.
        assert!(!client.is_eligible(&sentinel, &5));
        assert!(!client.is_eligible(&sentinel, &14));

        // Lock elapsed.
        assert!(client.is_eligible(&sentinel, &15));

        // The query is about the supplied ledger, not the current one: asking
        // about the past gives the answer for the past.
        assert!(!client.is_eligible(&sentinel, &5));
    }

    #[test]
    fn an_under_funded_or_deregistered_sentinel_is_never_eligible() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);

        env.ledger().with_mut(|l| l.sequence_number = 5);
        client.stake(&sentinel, &250);
        assert!(client.is_eligible(&sentinel, &20));

        // Raising the floor above the balance makes the sentinel ineligible
        // without touching its stake.
        client.set_min_stake(&admin, &500);
        assert!(!client.is_eligible(&sentinel, &20));
        assert_eq!(client.balance(&sentinel), 250);

        client.set_min_stake(&admin, &100);
        assert!(client.is_eligible(&sentinel, &20));

        // Deregistering ends eligibility immediately, even though the balance is
        // still there during the challenge period.
        client.deregister(&sentinel);
        assert!(!client.is_eligible(&sentinel, &20));
        assert_eq!(client.balance(&sentinel), 250);
    }

    #[test]
    fn eligibility_does_not_mutate_anything() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.stake(&sentinel, &250);

        let before = env.events().all().events().len();
        for ledger in [0_u32, 5, 15, 1_000] {
            let _ = client.is_eligible(&sentinel, &ledger);
        }
        assert_eq!(env.events().all().events().len(), before);
        assert_eq!(client.balance(&sentinel), 250);
        assert_eq!(client.total_stake(), 250);
    }

    // ── CT-49: emergency pause ──────────────────────────────────────────────

    #[test]
    fn a_paused_pool_stops_value_movement_but_not_its_controls() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let reason = Symbol::new(&env, "fraudulent_submission");

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.set_governance(&admin, &governance);
        client.stake(&sentinel, &250);

        client.pause(&governance);
        assert!(client.is_paused());

        env.ledger().with_mut(|l| l.sequence_number = 20);

        // Frozen.
        assert!(client.try_stake(&sentinel, &50).is_err());
        assert!(client.try_withdraw(&sentinel, &50).is_err());
        assert!(client.try_slash(&governance, &sentinel, &50, &reason).is_err());
        assert!(client.try_deregister(&sentinel).is_err());

        // Still working: the controls and the configuration, because those are
        // exactly what you need during an incident.
        assert_eq!(client.total_stake(), 250);
        assert_eq!(client.balance(&sentinel), 250);
        client.set_threshold(&admin, &5);
        client.set_min_stake(&admin, &150);
        client.set_challenge_period(&admin, &100);
        // Pausing twice is idempotent, not an error.
        client.pause(&governance);

        assert_eq!(client.balance(&sentinel), 250);
        assert_eq!(client.total_stake(), 250);
        assert_eq!(client.threshold(), 5);
    }

    #[test]
    fn unpausing_restores_value_movement() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.set_governance(&admin, &governance);
        client.stake(&sentinel, &250);

        client.pause(&governance);
        client.unpause(&governance);
        assert!(!client.is_paused());

        env.ledger().with_mut(|l| l.sequence_number = 20);
        client.withdraw(&sentinel, &50);
        assert_eq!(client.balance(&sentinel), 200);
        assert_eq!(client.total_stake(), 200);
    }

    #[test]
    fn the_pause_control_is_governance_only_with_no_fallback() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let attacker = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);

        // Unconfigured: nobody, including the admin, can pause.
        assert!(client.try_pause(&admin).is_err());
        assert!(!client.is_paused());

        client.set_governance(&admin, &admin);

        // Configured: only the configured address.
        assert!(client.try_pause(&attacker).is_err());
        assert!(!client.is_paused());
        client.pause(&admin);
        assert!(client.is_paused());
    }

    #[test]
    fn a_pause_cannot_be_rotated_away_by_an_unauthorized_address() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let attacker = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.set_governance(&admin, &governance);
        client.pause(&governance);

        // Only the admin can rotate the pause authority, not governance and
        // certainly not a stranger.
        assert!(client.try_set_governance(&governance, &attacker).is_err());
        assert!(client.try_set_governance(&attacker, &attacker).is_err());
        assert!(client.try_pause(&attacker).is_err());
        assert!(client.is_paused());
    }

    #[test]
    fn unpausing_a_running_pool_is_refused() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.set_governance(&admin, &governance);

        assert!(client.try_unpause(&governance).is_err());

        client.pause(&governance);
        client.unpause(&governance);
        // Already lifted: refused rather than silently accepted.
        assert!(client.try_unpause(&governance).is_err());
    }

    // ── CT-50: exit after deregistration ────────────────────────────────────

    #[test]
    fn an_exit_needs_deregistration_and_then_the_challenge_period() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.set_challenge_period(&admin, &100);
        client.stake(&sentinel, &250);

        // Registered: a full exit is refused, and it is refused *because* the
        // sentinel never deregistered.
        env.ledger().with_mut(|l| l.sequence_number = 20);
        assert!(client.try_withdraw(&sentinel, &250).is_err());
        assert_eq!(client.balance(&sentinel), 250);
        assert_eq!(client.deregistered_at(&sentinel), None);
        assert_eq!(client.withdrawable_at(&sentinel), None);

        client.deregister(&sentinel);
        assert_eq!(client.deregistered_at(&sentinel), Some(20));
        assert_eq!(client.withdrawable_at(&sentinel), Some(120));

        // Lock elapsed but the challenge period has not.
        env.ledger().with_mut(|l| l.sequence_number = 50);
        assert!(client.try_withdraw(&sentinel, &250).is_err());
        assert_eq!(client.balance(&sentinel), 250);

        // One ledger before the challenge deadline.
        env.ledger().with_mut(|l| l.sequence_number = 119);
        assert!(client.try_withdraw(&sentinel, &250).is_err());

        // The deadline itself.
        env.ledger().with_mut(|l| l.sequence_number = 120);
        client.withdraw(&sentinel, &250);
        assert_eq!(client.balance(&sentinel), 0);
        assert_eq!(client.total_stake(), 0);
    }

    #[test]
    fn a_deregistered_sentinel_can_still_take_a_partial_withdrawal() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.set_challenge_period(&admin, &100);
        client.stake(&sentinel, &250);
        client.deregister(&sentinel);

        env.ledger().with_mut(|l| l.sequence_number = 20);

        // Before the challenge deadline, the floor still applies to a partial
        // withdrawal: the challenge period gates the *exit*, not ordinary
        // withdrawals, which were always allowed down to the floor.
        assert!(client.try_withdraw(&sentinel, &200).is_err());
        client.withdraw(&sentinel, &150);
        assert_eq!(client.balance(&sentinel), 100);

        env.ledger().with_mut(|l| l.sequence_number = 120);
        client.withdraw(&sentinel, &100);
        assert_eq!(client.balance(&sentinel), 0);
    }

    #[test]
    fn deregistration_is_refused_twice_and_without_a_stake() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let sentinel = Address::generate(&env);
        let stranger = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);

        // Nothing to deregister from.
        assert!(client.try_deregister(&stranger).is_err());

        client.stake(&sentinel, &250);
        client.deregister(&sentinel);

        // A second call would hand out a fresh challenge period.
        assert!(client.try_deregister(&sentinel).is_err());
        assert_eq!(client.deregistered_at(&sentinel), Some(0));
    }

    #[test]
    fn the_challenge_period_is_bounded_and_admin_only() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let attacker = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);

        assert_eq!(client.challenge_period(), DEFAULT_CHALLENGE_PERIOD_LEDGERS);

        assert!(client.try_set_challenge_period(&attacker, &10).is_err());
        assert!(client.try_set_challenge_period(&admin, &0).is_err());
        assert!(client
            .try_set_challenge_period(&admin, &(MAX_CHALLENGE_PERIOD_LEDGERS + 1))
            .is_err());
        assert_eq!(client.challenge_period(), DEFAULT_CHALLENGE_PERIOD_LEDGERS);

        client.set_challenge_period(&admin, &MAX_CHALLENGE_PERIOD_LEDGERS);
        assert_eq!(client.challenge_period(), MAX_CHALLENGE_PERIOD_LEDGERS);
    }

    #[test]
    fn shortening_the_challenge_period_does_not_shorten_a_running_one() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.set_challenge_period(&admin, &1_000);
        client.stake(&sentinel, &250);

        env.ledger().with_mut(|l| l.sequence_number = 1_000);
        client.deregister(&sentinel);
        assert_eq!(client.withdrawable_at(&sentinel), Some(2_000));

        client.set_challenge_period(&admin, &1);

        // The deadline recorded at deregistration stands.
        assert_eq!(client.withdrawable_at(&sentinel), Some(2_000));
        env.ledger().with_mut(|l| l.sequence_number = 1_500);
        assert!(client.try_withdraw(&sentinel, &250).is_err());
        env.ledger().with_mut(|l| l.sequence_number = 2_000);
        client.withdraw(&sentinel, &250);
    }

    #[test]
    fn an_exited_sentinel_can_return_to_the_set() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.set_challenge_period(&admin, &100);
        client.stake(&sentinel, &250);

        client.deregister(&sentinel);
        env.ledger().with_mut(|l| l.sequence_number = 120);
        client.withdraw(&sentinel, &250);
        assert_eq!(client.balance(&sentinel), 0);
        assert_eq!(client.total_stake(), 0);

        // Completing the exit closed out the deregistration, so nothing is left
        // to block a fresh registration.
        assert_eq!(client.deregistered_at(&sentinel), None);
        assert_eq!(client.withdrawable_at(&sentinel), None);

        // Re-staking starts a new lock; eligibility follows it.
        env.ledger().with_mut(|l| l.sequence_number = 200);
        client.stake(&sentinel, &250);
        assert_eq!(client.balance(&sentinel), 250);
        assert_eq!(client.total_stake(), 250);
        assert!(!client.is_eligible(&sentinel, &200));
        assert!(client.is_eligible(&sentinel, &210));

        // A fresh full exit still needs its own deregistration and its own
        // challenge period.
        assert!(client.try_withdraw(&sentinel, &250).is_err());
        client.deregister(&sentinel);
        assert_eq!(client.withdrawable_at(&sentinel), Some(300));
        env.ledger().with_mut(|l| l.sequence_number = 299);
        assert!(client.try_withdraw(&sentinel, &250).is_err());
        env.ledger().with_mut(|l| l.sequence_number = 300);
        client.withdraw(&sentinel, &250);
        assert_eq!(client.balance(&sentinel), 0);
    }

    #[test]
    fn a_deregistered_sentinel_cannot_top_up_to_reset_the_challenge_period() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SentinelPool);
        let client = SentinelPoolClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let sentinel = Address::generate(&env);

        env.mock_all_auths();
        client.initialize(&admin, &100, &10, &2);
        client.set_challenge_period(&admin, &1_000);
        client.stake(&sentinel, &250);
        client.deregister(&sentinel);

        // A one-unit top-up must not be able to reset the recorded window.
        assert!(client.try_stake(&sentinel, &1).is_err());
        assert_eq!(client.balance(&sentinel), 250);
        assert_eq!(client.withdrawable_at(&sentinel), Some(1_000));

        env.ledger().with_mut(|l| l.sequence_number = 999);
        assert!(client.try_withdraw(&sentinel, &250).is_err());
        env.ledger().with_mut(|l| l.sequence_number = 1_000);
        client.withdraw(&sentinel, &250);
    }
}
