//! Tests for the full CT-030..CT-037 daily-index series: storage and range
//! queries (CT-030), rounding rules (CT-031), deterministic aggregation
//! (CT-032), immutable history (CT-033), authorization (CT-034), events
//! (CT-035), storage versioning (CT-036), and admin transfer/recovery
//! (CT-037).

use crate::{
    round_half_away, DailyIndex, DailyIndexUpdated, DataKey, Error, KovaraIndex, KovaraIndexClient,
    Observation, PendingRecovery, PendingTransfer, KVI_BASELINE, KVI_SCALE, KVI_VALUE_MAX,
    MAX_HISTORY_WINDOW, RECOVERY_DELAY_LEDGERS, SCHEMA_VERSION,
};
use soroban_sdk::testutils::Ledger as _;
use soroban_sdk::testutils::{Address as _, Events};
use soroban_sdk::{symbol_short, vec, Address, Env, Event, IntoVal, Symbol, Vec};

struct Fixture<'a> {
    env: Env,
    client: KovaraIndexClient<'a>,
    contract_id: Address,
    admin: Address,
    updater: Address,
}

fn deploy() -> Fixture<'static> {
    let env = Env::default();
    let contract_id = env.register(KovaraIndex, ());
    let client = KovaraIndexClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let updater = Address::generate(&env);

    env.mock_all_auths();

    Fixture {
        env,
        client,
        contract_id,
        admin,
        updater,
    }
}

fn deploy_initialized() -> Fixture<'static> {
    let f = deploy();
    f.client.initialize(&f.admin);

    // CT-034 made a sentinel roster a precondition for any update. These
    // tests are not about authorization, so they run with the simplest roster
    // that satisfies it: one sentinel, threshold one.
    f.client
        .set_sentinels(&f.admin, &vec![&f.env, f.updater.clone()], &1);

    f
}

/// The signer list for a single-sentinel update.
fn solo(f: &Fixture) -> Vec<Address> {
    vec![&f.env, f.updater.clone()]
}

const NG: Symbol = symbol_short!("NG");
const DATE: u64 = 20_140;
const VALUE: i128 = 1_234_567;
const BASKET: u32 = 7;
const PERIOD_START: u64 = 1_700_000_000;
const PERIOD_END: u64 = 1_700_086_400;

fn set_index(f: &Fixture) {
    f.client.set_daily_index(
        &solo(f),
        &NG,
        &DATE,
        &VALUE,
        &BASKET,
        &PERIOD_START,
        &PERIOD_END,
    );
}

// ── Initialization and schema versioning (CT-036) ────────────────────────

#[test]
fn a_fresh_deployment_has_no_schema_version() {
    let f = deploy();

    assert_eq!(f.client.deployed_schema_version(), None);
    assert_eq!(f.client.expected_schema_version(), SCHEMA_VERSION);
    assert!(!f.client.is_schema_compatible());
}

#[test]
fn initialization_records_the_schema_version_and_admin() {
    let f = deploy_initialized();

    assert_eq!(f.client.deployed_schema_version(), Some(SCHEMA_VERSION));
    assert_eq!(f.client.admin(), Some(f.admin.clone()));
    assert!(f.client.is_schema_compatible());
}

#[test]
fn initializing_twice_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_initialize(&f.admin),
        Err(Ok(Error::AlreadyInitialized))
    );
}

/// Operations must not run against a contract with no recorded schema —
/// there is nothing to check compatibility against.
#[test]
fn operations_are_rejected_before_initialization() {
    let f = deploy();

    assert_eq!(
        f.client.try_set_daily_index(
            &solo(&f),
            &NG,
            &DATE,
            &VALUE,
            &BASKET,
            &PERIOD_START,
            &PERIOD_END
        ),
        Err(Ok(Error::NotInitialized))
    );

    assert_eq!(
        f.client.try_get_daily_index(&NG, &DATE),
        Err(Ok(Error::NotInitialized))
    );
}

/// The core CT-036 requirement: a deployment whose stored schema does not
/// match this build must be refused rather than operated on.
#[test]
fn an_incompatible_schema_is_rejected_for_writes() {
    let f = deploy_initialized();

    // Simulate data written by a future release.
    f.env.as_contract(&f.contract_id, || {
        f.env
            .storage()
            .instance()
            .set(&DataKey::Schema, &(SCHEMA_VERSION + 1));
    });

    assert!(!f.client.is_schema_compatible());
    assert_eq!(
        f.client.try_set_daily_index(
            &solo(&f),
            &NG,
            &DATE,
            &VALUE,
            &BASKET,
            &PERIOD_START,
            &PERIOD_END
        ),
        Err(Ok(Error::IncompatibleSchema))
    );
}

/// Reads are guarded too. Returning a record decoded under the wrong schema
/// is precisely the failure this prevents, and it is the quieter half —
/// a bad read produces a plausible wrong number rather than an error.
#[test]
fn an_incompatible_schema_is_rejected_for_reads() {
    let f = deploy_initialized();
    set_index(&f);

    f.env.as_contract(&f.contract_id, || {
        f.env
            .storage()
            .instance()
            .set(&DataKey::Schema, &(SCHEMA_VERSION + 1));
    });

    assert_eq!(
        f.client.try_get_daily_index(&NG, &DATE),
        Err(Ok(Error::IncompatibleSchema))
    );
}

/// An older stored schema is just as incompatible as a newer one — this
/// build cannot know the shape of data it predates either.
#[test]
fn an_older_schema_is_also_rejected() {
    let f = deploy_initialized();

    f.env.as_contract(&f.contract_id, || {
        f.env.storage().instance().set(&DataKey::Schema, &0u32);
    });

    assert_eq!(
        f.client.try_get_daily_index(&NG, &DATE),
        Err(Ok(Error::IncompatibleSchema))
    );
}

/// Records are keyed by schema version, so two schemas' data occupy disjoint
/// keyspaces. That is what lets a migration write v2 records without
/// destroying v1, and it is why a failed migration is recoverable.
#[test]
fn records_under_different_schemas_do_not_collide() {
    let f = deploy_initialized();
    set_index(&f);

    let other_schema = SCHEMA_VERSION + 1;

    f.env.as_contract(&f.contract_id, || {
        // A record written by a different schema, at the same country/date.
        let foreign = DailyIndex {
            country: NG,
            date: DATE,
            value: 999,
            basket_version: 1,
            source_period_start: PERIOD_START,
            source_period_end: PERIOD_END,
            updater: f.updater.clone(),
            schema_version: other_schema,
        };

        f.env
            .storage()
            .persistent()
            .set(&DataKey::DailyIndex(other_schema, NG, DATE), &foreign);

        // The v1 record is untouched.
        let ours: DailyIndex = f
            .env
            .storage()
            .persistent()
            .get(&DataKey::DailyIndex(SCHEMA_VERSION, NG, DATE))
            .expect("v1 record still present");

        assert_eq!(ours.value, VALUE);
        assert_eq!(ours.schema_version, SCHEMA_VERSION);
    });
}

#[test]
fn stored_records_carry_the_schema_they_were_written_under() {
    let f = deploy_initialized();
    set_index(&f);

    let record = f.client.get_daily_index(&NG, &DATE).unwrap();

    assert_eq!(record.schema_version, SCHEMA_VERSION);
}

// ── Complete daily index events (CT-035) ─────────────────────────────────

/// Build the event the contract is expected to have emitted, from the field
/// values it was given.
///
/// Comparing against a constructed `DailyIndexUpdated` rather than poking at
/// topics and data by hand means the assertion covers *every* field: if a
/// field were dropped from the event, or emitted with the wrong value, this
/// stops matching.
fn expected_event(
    f: &Fixture,
    event: &DailyIndexUpdated,
) -> soroban_sdk::Vec<(
    Address,
    soroban_sdk::Vec<soroban_sdk::Val>,
    soroban_sdk::Val,
)> {
    vec![
        &f.env,
        (
            f.contract_id.clone(),
            event.topics(&f.env),
            event.data(&f.env),
        ),
    ]
}

/// Events from the most recent invocation only — `Events::all()` does not
/// accumulate across calls, so anything asserting on an event has to look
/// immediately after the call that emitted it.
fn emitted_count(f: &Fixture) -> usize {
    f.env.events().all().events().len()
}

/// The acceptance criterion: events include country, date, value, basket,
/// source period, and updater.
#[test]
fn the_event_carries_every_required_field() {
    let f = deploy_initialized();
    set_index(&f);

    let expected = DailyIndexUpdated {
        country: NG,
        date: DATE,
        value: VALUE,
        basket_version: BASKET,
        source_period_start: PERIOD_START,
        source_period_end: PERIOD_END,
        updater: f.updater.clone(),
        schema_version: SCHEMA_VERSION,
    };

    assert_eq!(f.env.events().all(), expected_event(&f, &expected));
}

/// Country and date are topics so an indexer can subscribe to one country
/// without decoding every event body.
#[test]
fn country_and_date_are_indexable_topics() {
    let f = deploy_initialized();
    set_index(&f);

    let event = DailyIndexUpdated {
        country: NG,
        date: DATE,
        value: VALUE,
        basket_version: BASKET,
        source_period_start: PERIOD_START,
        source_period_end: PERIOD_END,
        updater: f.updater.clone(),
        schema_version: SCHEMA_VERSION,
    };

    let topics = event.topics(&f.env);

    let country_topic: soroban_sdk::Val = NG.into_val(&f.env);
    let date_topic: soroban_sdk::Val = DATE.into_val(&f.env);
    let value_val: soroban_sdk::Val = VALUE.into_val(&f.env);

    assert!(
        topics.contains(country_topic),
        "country should be a topic: {topics:?}"
    );
    assert!(
        topics.contains(date_topic),
        "date should be a topic: {topics:?}"
    );

    // And the value is not a topic — it belongs in the data section.
    assert!(!topics.contains(value_val));
}

/// The event must describe the record that was actually stored — a consumer
/// acting on the event alone must not diverge from one that reads state.
#[test]
fn the_event_matches_the_stored_record() {
    let f = deploy_initialized();
    set_index(&f);

    // Capture the event before any further call: the read below would
    // otherwise replace it, since events do not accumulate.
    let emitted = f.env.events().all();

    let stored = f.client.get_daily_index(&NG, &DATE).unwrap();

    let from_storage = DailyIndexUpdated {
        country: stored.country.clone(),
        date: stored.date,
        value: stored.value,
        basket_version: stored.basket_version,
        source_period_start: stored.source_period_start,
        source_period_end: stored.source_period_end,
        updater: stored.updater.clone(),
        schema_version: stored.schema_version,
    };

    assert_eq!(emitted, expected_event(&f, &from_storage));
}

/// Every accepted update emits exactly one event — not zero, and not a
/// duplicate.
#[test]
fn each_update_emits_exactly_one_event() {
    let f = deploy_initialized();

    set_index(&f);
    assert_eq!(emitted_count(&f), 1);

    f.client.set_daily_index(
        &solo(&f),
        &symbol_short!("KE"),
        &DATE,
        &VALUE,
        &BASKET,
        &PERIOD_START,
        &PERIOD_END,
    );
    assert_eq!(emitted_count(&f), 1);
}

/// A rejected update must emit nothing — an event for a write that did not
/// happen is worse than no event.
#[test]
fn a_rejected_update_emits_no_event() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_set_daily_index(
            &solo(&f),
            &NG,
            &DATE,
            &VALUE,
            &0u32, // invalid basket
            &PERIOD_START,
            &PERIOD_END
        ),
        Err(Ok(Error::InvalidBasketVersion))
    );

    assert_eq!(emitted_count(&f), 0);
}

// ── Field validation ─────────────────────────────────────────────────────

/// Zero is reserved for "no basket recorded", which is the ambiguity CT-035
/// exists to remove — so it cannot also be a valid basket.
#[test]
fn a_zero_basket_version_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_set_daily_index(
            &solo(&f),
            &NG,
            &DATE,
            &VALUE,
            &0u32,
            &PERIOD_START,
            &PERIOD_END
        ),
        Err(Ok(Error::InvalidBasketVersion))
    );
}

#[test]
fn a_backwards_source_period_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_set_daily_index(
            &solo(&f),
            &NG,
            &DATE,
            &VALUE,
            &BASKET,
            &PERIOD_END,
            &PERIOD_START
        ),
        Err(Ok(Error::InvalidSourcePeriod))
    );
}

/// A period covering a single instant is legitimate — a spot observation.
#[test]
fn an_instantaneous_source_period_is_accepted() {
    let f = deploy_initialized();

    f.client.set_daily_index(
        &solo(&f),
        &NG,
        &DATE,
        &VALUE,
        &BASKET,
        &PERIOD_START,
        &PERIOD_START,
    );

    let record = f.client.get_daily_index(&NG, &DATE).unwrap();

    assert_eq!(record.source_period_start, record.source_period_end);
}

/// A rejected write must leave storage untouched.
#[test]
fn a_rejected_update_stores_nothing() {
    let f = deploy_initialized();

    assert!(f
        .client
        .try_set_daily_index(
            &solo(&f),
            &NG,
            &DATE,
            &VALUE,
            &0u32,
            &PERIOD_START,
            &PERIOD_END
        )
        .is_err());

    assert_eq!(f.client.get_daily_index(&NG, &DATE), None);
}

// ── Storage round-trip ───────────────────────────────────────────────────

#[test]
fn a_record_round_trips() {
    let f = deploy_initialized();
    set_index(&f);

    let record = f.client.get_daily_index(&NG, &DATE).unwrap();

    assert_eq!(
        record,
        DailyIndex {
            country: NG,
            date: DATE,
            value: VALUE,
            basket_version: BASKET,
            source_period_start: PERIOD_START,
            source_period_end: PERIOD_END,
            updater: f.updater.clone(),
            schema_version: SCHEMA_VERSION,
        }
    );
}

#[test]
fn an_unknown_country_or_date_reads_as_none() {
    let f = deploy_initialized();
    set_index(&f);

    assert_eq!(f.client.get_daily_index(&symbol_short!("ZZ"), &DATE), None);
    assert_eq!(f.client.get_daily_index(&NG, &(DATE + 1)), None);
}

#[test]
fn records_are_kept_per_country_and_per_date() {
    let f = deploy_initialized();

    f.client.set_daily_index(
        &solo(&f),
        &NG,
        &DATE,
        &100,
        &BASKET,
        &PERIOD_START,
        &PERIOD_END,
    );
    f.client.set_daily_index(
        &solo(&f),
        &symbol_short!("KE"),
        &DATE,
        &200,
        &BASKET,
        &PERIOD_START,
        &PERIOD_END,
    );
    f.client.set_daily_index(
        &solo(&f),
        &NG,
        &(DATE + 1),
        &300,
        &BASKET,
        &PERIOD_START,
        &PERIOD_END,
    );

    assert_eq!(f.client.get_daily_index(&NG, &DATE).unwrap().value, 100);
    assert_eq!(
        f.client
            .get_daily_index(&symbol_short!("KE"), &DATE)
            .unwrap()
            .value,
        200
    );
    assert_eq!(
        f.client.get_daily_index(&NG, &(DATE + 1)).unwrap().value,
        300
    );
}

/// Negative values within the CT-031 bounds ([`KVI_VALUE_MAX`]) are storable
/// as given; the rounding and aggregation rules decide what is produced, not
/// whether a signed value may be stored.
#[test]
fn a_negative_value_is_stored_as_given() {
    let f = deploy_initialized();

    f.client.set_daily_index(
        &solo(&f),
        &NG,
        &DATE,
        &-42,
        &BASKET,
        &PERIOD_START,
        &PERIOD_END,
    );

    assert_eq!(f.client.get_daily_index(&NG, &DATE).unwrap().value, -42);
}

/// Authorization *policy* is CT-034's. What this pins is narrower and still
/// necessary: the address recorded as `updater` is the address that signed,
/// so the field means something.
#[test]
#[should_panic(expected = "Unauthorized function call for address")]
fn an_unsigned_update_is_rejected_by_the_host() {
    let f = deploy_initialized();

    f.env.set_auths(&[]);

    set_index(&f);
}

// ═══════════════════════════════════════════════════════════════════════════
// CT-034 — authorize index updates (#509)
// ═══════════════════════════════════════════════════════════════════════════

/// A roster of `n` fresh sentinels at the given threshold.
fn roster(f: &Fixture, n: u32, threshold: u32) -> Vec<Address> {
    let mut sentinels = Vec::new(&f.env);

    for _ in 0..n {
        sentinels.push_back(Address::generate(&f.env));
    }

    f.client.set_sentinels(&f.admin, &sentinels, &threshold);

    sentinels
}

/// Attempt an update with the given signer set.
///
/// A macro rather than a function so the caller never has to spell out the
/// generated client's nested `try_` result type.
macro_rules! update_with {
    ($f:expr, $signers:expr) => {
        $f.client.try_set_daily_index(
            $signers,
            &NG,
            &DATE,
            &VALUE,
            &BASKET,
            &PERIOD_START,
            &PERIOD_END,
        )
    };
}

#[test]
fn the_roster_and_threshold_are_readable() {
    let f = deploy_initialized();
    let sentinels = roster(&f, 3, 2);

    assert_eq!(f.client.get_sentinels(), sentinels);
    assert_eq!(f.client.get_threshold(), 2);
    assert!(f.client.is_sentinel(&sentinels.get(0).unwrap()));
    assert!(!f.client.is_sentinel(&Address::generate(&f.env)));
}

/// An update before any roster exists must fail closed, not fall back to
/// "anyone may update".
#[test]
fn an_update_before_sentinels_are_configured_is_rejected() {
    let f = deploy();
    f.client.initialize(&f.admin);

    assert_eq!(
        update_with!(&f, &vec![&f.env, f.updater.clone()]),
        Err(Ok(Error::SentinelsNotConfigured))
    );
}

/// **Unauthorized**: a signer that is not on the roster.
#[test]
fn an_update_signed_by_a_non_sentinel_is_rejected() {
    let f = deploy_initialized();
    let sentinels = roster(&f, 3, 2);
    let outsider = Address::generate(&f.env);

    assert_eq!(
        update_with!(&f, &vec![&f.env, sentinels.get(0).unwrap(), outsider]),
        Err(Ok(Error::NotASentinel))
    );
}

#[test]
fn an_update_signed_only_by_outsiders_is_rejected() {
    let f = deploy_initialized();
    roster(&f, 3, 2);

    let a = Address::generate(&f.env);
    let b = Address::generate(&f.env);

    assert_eq!(
        update_with!(&f, &vec![&f.env, a, b]),
        Err(Ok(Error::NotASentinel))
    );
}

/// **Insufficiently authorized**: real sentinels, but too few of them.
#[test]
fn an_update_below_the_threshold_is_rejected() {
    let f = deploy_initialized();
    let sentinels = roster(&f, 3, 2);

    assert_eq!(
        update_with!(&f, &vec![&f.env, sentinels.get(0).unwrap()]),
        Err(Ok(Error::InsufficientSignatures))
    );
}

#[test]
fn an_update_with_no_signers_is_rejected() {
    let f = deploy_initialized();
    roster(&f, 3, 2);

    assert_eq!(
        update_with!(&f, &Vec::new(&f.env)),
        Err(Ok(Error::InsufficientSignatures))
    );
}

/// The check that makes a threshold mean anything: without it, one sentinel
/// could sign twice and satisfy a 2-of-3 policy alone.
#[test]
fn one_sentinel_cannot_meet_the_threshold_by_signing_twice() {
    let f = deploy_initialized();
    let sentinels = roster(&f, 3, 2);
    let lone = sentinels.get(0).unwrap();

    assert_eq!(
        update_with!(&f, &vec![&f.env, lone.clone(), lone]),
        Err(Ok(Error::DuplicateSigner))
    );
}

#[test]
fn an_update_meeting_the_threshold_succeeds() {
    let f = deploy_initialized();
    let sentinels = roster(&f, 3, 2);

    assert_eq!(
        update_with!(
            &f,
            &vec![&f.env, sentinels.get(0).unwrap(), sentinels.get(1).unwrap()]
        ),
        Ok(Ok(()))
    );

    assert_eq!(f.client.get_daily_index(&NG, &DATE).unwrap().value, VALUE);
}

#[test]
fn more_signers_than_the_threshold_is_accepted() {
    let f = deploy_initialized();
    let s = roster(&f, 3, 2);

    assert_eq!(
        update_with!(
            &f,
            &vec![
                &f.env,
                s.get(0).unwrap(),
                s.get(1).unwrap(),
                s.get(2).unwrap()
            ]
        ),
        Ok(Ok(()))
    );
}

/// The first signer is the submitter, and is what the record and the CT-035
/// event attribute the update to.
#[test]
fn the_first_signer_is_recorded_as_the_updater() {
    let f = deploy_initialized();
    let s = roster(&f, 3, 2);
    let submitter = s.get(0).unwrap();

    update_with!(&f, &vec![&f.env, submitter.clone(), s.get(1).unwrap()])
        .unwrap()
        .unwrap();

    assert_eq!(
        f.client.get_daily_index(&NG, &DATE).unwrap().updater,
        submitter
    );
}

#[test]
#[should_panic(expected = "Unauthorized function call for address")]
fn an_unsigned_update_is_rejected_by_the_host_even_with_valid_sentinels() {
    let f = deploy_initialized();
    let s = roster(&f, 2, 2);

    f.env.set_auths(&[]);

    f.client.set_daily_index(
        &vec![&f.env, s.get(0).unwrap(), s.get(1).unwrap()],
        &NG,
        &DATE,
        &VALUE,
        &BASKET,
        &PERIOD_START,
        &PERIOD_END,
    );
}

// ── Rotation ─────────────────────────────────────────────────────────────

/// The rotation case that matters: after rotating, the old roster must stop
/// working and the new one must start.
#[test]
fn rotation_revokes_the_old_roster_and_installs_the_new_one() {
    let f = deploy_initialized();
    let old = roster(&f, 3, 2);

    assert_eq!(
        update_with!(&f, &vec![&f.env, old.get(0).unwrap(), old.get(1).unwrap()]),
        Ok(Ok(()))
    );

    let new = roster(&f, 3, 2);

    // Every former sentinel is now an outsider.
    assert_eq!(
        update_with!(&f, &vec![&f.env, old.get(0).unwrap(), old.get(1).unwrap()]),
        Err(Ok(Error::NotASentinel))
    );

    // A mixed set is rejected too — a revoked key cannot ride along.
    assert_eq!(
        update_with!(&f, &vec![&f.env, new.get(0).unwrap(), old.get(0).unwrap()]),
        Err(Ok(Error::NotASentinel))
    );

    // A fresh day (CT-033 made NG@DATE immutable after the first write).
    assert_eq!(
        f.client.try_set_daily_index(
            &vec![&f.env, new.get(0).unwrap(), new.get(1).unwrap()],
            &NG,
            &(DATE + 1),
            &VALUE,
            &BASKET,
            &PERIOD_START,
            &PERIOD_END,
        ),
        Ok(Ok(()))
    );
}

#[test]
fn rotation_can_raise_and_lower_the_threshold() {
    let f = deploy_initialized();
    let s = roster(&f, 3, 1);

    assert_eq!(
        update_with!(&f, &vec![&f.env, s.get(0).unwrap()]),
        Ok(Ok(()))
    );

    f.client.set_sentinels(&f.admin, &s, &3);
    assert_eq!(f.client.get_threshold(), 3);

    assert_eq!(
        update_with!(&f, &vec![&f.env, s.get(0).unwrap(), s.get(1).unwrap()]),
        Err(Ok(Error::InsufficientSignatures))
    );

    f.client.set_sentinels(&f.admin, &s, &1);
    assert_eq!(
        f.client.try_set_daily_index(
            &vec![&f.env, s.get(0).unwrap()],
            &NG,
            &(DATE + 1),
            &VALUE,
            &BASKET,
            &PERIOD_START,
            &PERIOD_END,
        ),
        Ok(Ok(()))
    );
}

#[test]
fn only_the_admin_can_rotate() {
    let f = deploy_initialized();
    let stranger = Address::generate(&f.env);

    assert_eq!(
        f.client
            .try_set_sentinels(&stranger, &vec![&f.env, stranger.clone()], &1),
        Err(Ok(Error::NotAdmin))
    );
}

#[test]
fn a_threshold_larger_than_the_roster_is_rejected() {
    let f = deploy_initialized();
    let sentinels = vec![&f.env, Address::generate(&f.env), Address::generate(&f.env)];

    assert_eq!(
        f.client.try_set_sentinels(&f.admin, &sentinels, &3),
        Err(Ok(Error::InvalidThreshold))
    );
}

#[test]
fn a_zero_threshold_is_rejected() {
    let f = deploy_initialized();
    let sentinels = vec![&f.env, Address::generate(&f.env)];

    assert_eq!(
        f.client.try_set_sentinels(&f.admin, &sentinels, &0),
        Err(Ok(Error::InvalidThreshold))
    );
}

#[test]
fn an_empty_roster_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_set_sentinels(&f.admin, &Vec::new(&f.env), &1),
        Err(Ok(Error::EmptySentinelSet))
    );
}

/// A duplicate in the roster would inflate its apparent size, letting a
/// threshold be met by fewer real parties than it names.
#[test]
fn a_duplicated_sentinel_in_the_roster_is_rejected() {
    let f = deploy_initialized();
    let dup = Address::generate(&f.env);

    assert_eq!(
        f.client
            .try_set_sentinels(&f.admin, &vec![&f.env, dup.clone(), dup], &2),
        Err(Ok(Error::DuplicateSentinel))
    );
}

#[test]
fn a_rejected_rotation_leaves_the_previous_roster_in_place() {
    let f = deploy_initialized();
    let good = roster(&f, 2, 2);

    assert!(f
        .client
        .try_set_sentinels(&f.admin, &Vec::new(&f.env), &1)
        .is_err());

    assert_eq!(f.client.get_sentinels(), good);
    assert_eq!(f.client.get_threshold(), 2);
}

// ═══════════════════════════════════════════════════════════════════════════
// CT-037 — admin transfer and recovery (#512)
// ═══════════════════════════════════════════════════════════════════════════

const FAR_FUTURE: u32 = 1_000_000;

// ── Two-step transfer ────────────────────────────────────────────────────

/// The whole point of two steps: proposing must not move control. A
/// single-step transfer to a mistyped address strands the contract.
#[test]
fn proposing_a_transfer_does_not_change_the_admin() {
    let f = deploy_initialized();
    let next = Address::generate(&f.env);

    f.client
        .propose_admin_transfer(&f.admin, &next, &FAR_FUTURE);

    assert_eq!(f.client.admin(), Some(f.admin.clone()));
    assert_eq!(
        f.client.get_pending_transfer(),
        Some(PendingTransfer {
            new_admin: next,
            expires_at: FAR_FUTURE,
        })
    );
}

#[test]
fn accepting_a_transfer_moves_the_admin() {
    let f = deploy_initialized();
    let next = Address::generate(&f.env);

    f.client
        .propose_admin_transfer(&f.admin, &next, &FAR_FUTURE);
    f.client.accept_admin_transfer(&next);

    assert_eq!(f.client.admin(), Some(next.clone()));
    assert_eq!(f.client.get_pending_transfer(), None);

    // And the new admin can actually administer.
    f.client
        .set_sentinels(&next, &vec![&f.env, Address::generate(&f.env)], &1);
}

#[test]
fn the_old_admin_loses_authority_after_a_transfer() {
    let f = deploy_initialized();
    let next = Address::generate(&f.env);

    f.client
        .propose_admin_transfer(&f.admin, &next, &FAR_FUTURE);
    f.client.accept_admin_transfer(&next);

    assert_eq!(
        f.client
            .try_set_sentinels(&f.admin, &vec![&f.env, f.updater.clone()], &1),
        Err(Ok(Error::NotAdmin))
    );
}

#[test]
fn only_the_proposed_address_can_accept() {
    let f = deploy_initialized();
    let next = Address::generate(&f.env);
    let interloper = Address::generate(&f.env);

    f.client
        .propose_admin_transfer(&f.admin, &next, &FAR_FUTURE);

    assert_eq!(
        f.client.try_accept_admin_transfer(&interloper),
        Err(Ok(Error::NotProposedAdmin))
    );
    assert_eq!(f.client.admin(), Some(f.admin.clone()));
}

#[test]
fn accepting_without_a_pending_transfer_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client
            .try_accept_admin_transfer(&Address::generate(&f.env)),
        Err(Ok(Error::NoPendingTransfer))
    );
}

#[test]
fn only_the_admin_can_propose_a_transfer() {
    let f = deploy_initialized();
    let stranger = Address::generate(&f.env);

    assert_eq!(
        f.client
            .try_propose_admin_transfer(&stranger, &stranger, &FAR_FUTURE),
        Err(Ok(Error::NotAdmin))
    );
}

#[test]
fn transferring_to_the_current_admin_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client
            .try_propose_admin_transfer(&f.admin, &f.admin, &FAR_FUTURE),
        Err(Ok(Error::AlreadyAdmin))
    );
}

// ── Expiry ───────────────────────────────────────────────────────────────

/// An expiry stops a forgotten proposal from being accepted years later by
/// whoever ends up holding that key.
#[test]
fn an_expired_transfer_cannot_be_accepted() {
    let f = deploy_initialized();
    let next = Address::generate(&f.env);

    let expires_at = f.env.ledger().sequence() + 100;
    f.client
        .propose_admin_transfer(&f.admin, &next, &expires_at);

    f.env.ledger().set_sequence_number(expires_at + 1);

    assert_eq!(
        f.client.try_accept_admin_transfer(&next),
        Err(Ok(Error::TransferExpired))
    );
    assert_eq!(f.client.admin(), Some(f.admin.clone()));
}

/// The boundary is inclusive: a proposal is still acceptable *at* its expiry.
#[test]
fn a_transfer_is_acceptable_at_the_expiry_ledger_itself() {
    let f = deploy_initialized();
    let next = Address::generate(&f.env);

    let expires_at = f.env.ledger().sequence() + 100;
    f.client
        .propose_admin_transfer(&f.admin, &next, &expires_at);

    f.env.ledger().set_sequence_number(expires_at);

    f.client.accept_admin_transfer(&next);
    assert_eq!(f.client.admin(), Some(next));
}

#[test]
fn an_expiry_already_in_the_past_is_rejected() {
    let f = deploy_initialized();
    let next = Address::generate(&f.env);

    f.env.ledger().set_sequence_number(500);

    assert_eq!(
        f.client.try_propose_admin_transfer(&f.admin, &next, &499),
        Err(Ok(Error::InvalidExpiry))
    );
}

// ── Cancellation ─────────────────────────────────────────────────────────

#[test]
fn a_cancelled_transfer_cannot_be_accepted() {
    let f = deploy_initialized();
    let next = Address::generate(&f.env);

    f.client
        .propose_admin_transfer(&f.admin, &next, &FAR_FUTURE);
    f.client.cancel_admin_transfer(&f.admin);

    assert_eq!(f.client.get_pending_transfer(), None);
    assert_eq!(
        f.client.try_accept_admin_transfer(&next),
        Err(Ok(Error::NoPendingTransfer))
    );
    assert_eq!(f.client.admin(), Some(f.admin.clone()));
}

#[test]
fn cancelling_without_a_pending_transfer_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_cancel_admin_transfer(&f.admin),
        Err(Ok(Error::NoPendingTransfer))
    );
}

#[test]
fn only_the_admin_can_cancel_a_transfer() {
    let f = deploy_initialized();
    let next = Address::generate(&f.env);

    f.client
        .propose_admin_transfer(&f.admin, &next, &FAR_FUTURE);

    assert_eq!(
        f.client.try_cancel_admin_transfer(&next),
        Err(Ok(Error::NotAdmin))
    );
    assert!(f.client.get_pending_transfer().is_some());
}

#[test]
fn a_new_proposal_replaces_the_previous_one() {
    let f = deploy_initialized();
    let first = Address::generate(&f.env);
    let second = Address::generate(&f.env);

    f.client
        .propose_admin_transfer(&f.admin, &first, &FAR_FUTURE);
    f.client
        .propose_admin_transfer(&f.admin, &second, &FAR_FUTURE);

    assert_eq!(
        f.client.try_accept_admin_transfer(&first),
        Err(Ok(Error::NotProposedAdmin))
    );

    f.client.accept_admin_transfer(&second);
    assert_eq!(f.client.admin(), Some(second));
}

// ── Recovery ─────────────────────────────────────────────────────────────

/// The answer to a lost admin key: a sentinel quorum can recover control,
/// but only after a delay.
#[test]
fn a_sentinel_quorum_can_recover_administrative_control() {
    let f = deploy_initialized();
    let s = roster(&f, 3, 2);
    let rescuer = Address::generate(&f.env);

    let start = f.env.ledger().sequence();
    f.client.propose_admin_recovery(
        &vec![&f.env, s.get(0).unwrap(), s.get(1).unwrap()],
        &rescuer,
    );

    assert_eq!(
        f.client.get_pending_recovery(),
        Some(PendingRecovery {
            new_admin: rescuer.clone(),
            ready_at: start + RECOVERY_DELAY_LEDGERS,
        })
    );

    // Still the old admin until the delay elapses.
    assert_eq!(f.client.admin(), Some(f.admin.clone()));

    f.env
        .ledger()
        .set_sequence_number(start + RECOVERY_DELAY_LEDGERS);

    f.client.execute_admin_recovery();

    assert_eq!(f.client.admin(), Some(rescuer.clone()));
    assert_eq!(f.client.get_pending_recovery(), None);

    // The recovered admin can administer.
    f.client
        .set_sentinels(&rescuer, &vec![&f.env, Address::generate(&f.env)], &1);
}

#[test]
fn a_recovery_cannot_be_executed_before_its_timelock() {
    let f = deploy_initialized();
    let s = roster(&f, 3, 2);
    let rescuer = Address::generate(&f.env);

    let start = f.env.ledger().sequence();
    f.client.propose_admin_recovery(
        &vec![&f.env, s.get(0).unwrap(), s.get(1).unwrap()],
        &rescuer,
    );

    f.env
        .ledger()
        .set_sequence_number(start + RECOVERY_DELAY_LEDGERS - 1);

    assert_eq!(
        f.client.try_execute_admin_recovery(),
        Err(Ok(Error::RecoveryNotReady))
    );
    assert_eq!(f.client.admin(), Some(f.admin.clone()));
}

/// The delay exists so a still-live administrator can say no. This is what
/// stops the recovery path from being a way to seize a healthy contract.
#[test]
fn the_sitting_admin_can_veto_a_recovery() {
    let f = deploy_initialized();
    let s = roster(&f, 3, 2);
    let attacker = Address::generate(&f.env);

    let start = f.env.ledger().sequence();
    f.client.propose_admin_recovery(
        &vec![&f.env, s.get(0).unwrap(), s.get(1).unwrap()],
        &attacker,
    );

    f.client.cancel_admin_recovery(&f.admin);

    assert_eq!(f.client.get_pending_recovery(), None);

    f.env
        .ledger()
        .set_sequence_number(start + RECOVERY_DELAY_LEDGERS + 1);

    assert_eq!(
        f.client.try_execute_admin_recovery(),
        Err(Ok(Error::NoPendingRecovery))
    );
    assert_eq!(f.client.admin(), Some(f.admin.clone()));
}

#[test]
fn only_the_admin_can_veto_a_recovery() {
    let f = deploy_initialized();
    let s = roster(&f, 3, 2);
    let rescuer = Address::generate(&f.env);

    f.client.propose_admin_recovery(
        &vec![&f.env, s.get(0).unwrap(), s.get(1).unwrap()],
        &rescuer,
    );

    assert_eq!(
        f.client.try_cancel_admin_recovery(&rescuer),
        Err(Ok(Error::NotAdmin))
    );
    assert!(f.client.get_pending_recovery().is_some());
}

#[test]
fn a_non_sentinel_cannot_propose_a_recovery() {
    let f = deploy_initialized();
    roster(&f, 3, 2);

    let a = Address::generate(&f.env);
    let b = Address::generate(&f.env);

    assert_eq!(
        f.client
            .try_propose_admin_recovery(&vec![&f.env, a, b], &Address::generate(&f.env)),
        Err(Ok(Error::NotASentinel))
    );
}

#[test]
fn a_recovery_below_the_threshold_is_rejected() {
    let f = deploy_initialized();
    let s = roster(&f, 3, 2);

    assert_eq!(
        f.client.try_propose_admin_recovery(
            &vec![&f.env, s.get(0).unwrap()],
            &Address::generate(&f.env)
        ),
        Err(Ok(Error::InsufficientSignatures))
    );
}

#[test]
fn one_sentinel_cannot_propose_a_recovery_by_signing_twice() {
    let f = deploy_initialized();
    let s = roster(&f, 3, 2);
    let lone = s.get(0).unwrap();

    assert_eq!(
        f.client.try_propose_admin_recovery(
            &vec![&f.env, lone.clone(), lone],
            &Address::generate(&f.env)
        ),
        Err(Ok(Error::DuplicateSigner))
    );
}

#[test]
fn recovering_to_the_current_admin_is_rejected() {
    let f = deploy_initialized();
    let s = roster(&f, 3, 2);

    assert_eq!(
        f.client.try_propose_admin_recovery(
            &vec![&f.env, s.get(0).unwrap(), s.get(1).unwrap()],
            &f.admin
        ),
        Err(Ok(Error::AlreadyAdmin))
    );
}

#[test]
fn executing_without_a_pending_recovery_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_execute_admin_recovery(),
        Err(Ok(Error::NoPendingRecovery))
    );
}

// ── Interaction between the two paths ────────────────────────────────────

/// A completed handover proves control just moved, so a recovery premised on
/// the old admin's absence is stale.
#[test]
fn accepting_a_transfer_clears_a_pending_recovery() {
    let f = deploy_initialized();
    let s = roster(&f, 3, 2);
    let next = Address::generate(&f.env);

    f.client.propose_admin_recovery(
        &vec![&f.env, s.get(0).unwrap(), s.get(1).unwrap()],
        &Address::generate(&f.env),
    );
    f.client
        .propose_admin_transfer(&f.admin, &next, &FAR_FUTURE);
    f.client.accept_admin_transfer(&next);

    assert_eq!(f.client.get_pending_recovery(), None);
    assert_eq!(f.client.admin(), Some(next));
}

/// And a completed recovery ends the displaced administrator's authority,
/// including any handover they had proposed.
#[test]
fn executing_a_recovery_clears_a_pending_transfer() {
    let f = deploy_initialized();
    let s = roster(&f, 3, 2);
    let rescuer = Address::generate(&f.env);
    let stale_target = Address::generate(&f.env);

    f.client
        .propose_admin_transfer(&f.admin, &stale_target, &FAR_FUTURE);

    let start = f.env.ledger().sequence();
    f.client.propose_admin_recovery(
        &vec![&f.env, s.get(0).unwrap(), s.get(1).unwrap()],
        &rescuer,
    );

    f.env
        .ledger()
        .set_sequence_number(start + RECOVERY_DELAY_LEDGERS);
    f.client.execute_admin_recovery();

    assert_eq!(f.client.admin(), Some(rescuer));
    assert_eq!(f.client.get_pending_transfer(), None);
    assert_eq!(
        f.client.try_accept_admin_transfer(&stale_target),
        Err(Ok(Error::NoPendingTransfer))
    );
}

/// Rotation and recovery compose: the roster in force at proposal time is
/// what counts, and a rotated-out sentinel cannot start a recovery.
#[test]
fn a_rotated_out_sentinel_cannot_propose_a_recovery() {
    let f = deploy_initialized();
    let old = roster(&f, 3, 2);
    roster(&f, 3, 2);

    assert_eq!(
        f.client.try_propose_admin_recovery(
            &vec![&f.env, old.get(0).unwrap(), old.get(1).unwrap()],
            &Address::generate(&f.env)
        ),
        Err(Ok(Error::NotASentinel))
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// CT-030 — daily KovaraIndex storage (#505)
// ═══════════════════════════════════════════════════════════════════════════

/// Three consecutive days for the fixture country, written in order.
fn write_three_days(f: &Fixture) {
    f.client.set_daily_index(
        &solo(f),
        &NG,
        &DATE,
        &100,
        &BASKET,
        &PERIOD_START,
        &PERIOD_END,
    );
    f.client.set_daily_index(
        &solo(f),
        &NG,
        &(DATE + 1),
        &200,
        &BASKET,
        &PERIOD_START,
        &PERIOD_END,
    );
    f.client.set_daily_index(
        &solo(f),
        &NG,
        &(DATE + 2),
        &300,
        &BASKET,
        &PERIOD_START,
        &PERIOD_END,
    );
}

#[test]
fn latest_is_none_before_any_write() {
    let f = deploy_initialized();

    assert_eq!(f.client.latest_daily_index(&NG), None);
}

#[test]
fn latest_returns_the_most_recent_record() {
    let f = deploy_initialized();
    write_three_days(&f);

    let latest = f.client.latest_daily_index(&NG).unwrap();

    assert_eq!(latest.date, DATE + 2);
    assert_eq!(latest.value, 300);
}

#[test]
fn history_returns_the_requested_range_ascending() {
    let f = deploy_initialized();
    write_three_days(&f);

    let records = f.client.daily_index_history(&NG, &DATE, &(DATE + 2));

    assert_eq!(records.len(), 3);
    assert_eq!(records.get(0).unwrap().date, DATE);
    assert_eq!(records.get(1).unwrap().date, DATE + 1);
    assert_eq!(records.get(2).unwrap().date, DATE + 2);

    let subset = f.client.daily_index_history(&NG, &(DATE + 1), &(DATE + 2));
    assert_eq!(subset.len(), 2);
    assert_eq!(subset.get(0).unwrap().date, DATE + 1);
}

#[test]
fn history_is_empty_when_nothing_matches() {
    let f = deploy_initialized();
    write_three_days(&f);

    assert_eq!(
        f.client
            .daily_index_history(&NG, &(DATE + 5), &(DATE + 6))
            .len(),
        0
    );
    assert_eq!(
        f.client
            .daily_index_history(&symbol_short!("ZZ"), &DATE, &(DATE + 2))
            .len(),
        0
    );
}

#[test]
fn an_inverted_history_range_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_daily_index_history(&NG, &(DATE + 2), &DATE),
        Err(Ok(Error::InvalidHistoryRange))
    );
}

#[test]
fn a_history_range_wider_than_the_max_window_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client
            .try_daily_index_history(&NG, &DATE, &(DATE + MAX_HISTORY_WINDOW + 1)),
        Err(Ok(Error::HistoryWindowTooLarge))
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// CT-031 — KVI rounding rules (#506)
// ═══════════════════════════════════════════════════════════════════════════

/// The scale and the baseline are pinned so consumers can reproduce values.
#[test]
fn the_scale_and_baseline_are_pinned() {
    assert_eq!(KVI_SCALE, 10_000);
    assert_eq!(KVI_BASELINE, 100 * KVI_SCALE);
}

#[test]
fn rounding_is_half_away_from_zero() {
    assert_eq!(round_half_away(5, 2), 3); //   2.5  ->  3
    assert_eq!(round_half_away(-5, 2), -3); //  -2.5  -> -3
    assert_eq!(round_half_away(4, 2), 2); //   2.0  ->  2
    assert_eq!(round_half_away(-4, 2), -2); //  -2.0  -> -2
    assert_eq!(round_half_away(1, 2), 1); //   0.5  ->  1
    assert_eq!(round_half_away(-1, 2), -1); //  -0.5  -> -1
    assert_eq!(round_half_away(7, 3), 2); //   2.33 ->  2
    assert_eq!(round_half_away(-7, 3), -2); //  -2.33 -> -2
}

/// The overflow rule: values outside the documented bounds are rejected
/// rather than stored, and nothing is persisted by the rejected writes.
#[test]
fn a_value_beyond_the_documented_bounds_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_set_daily_index(
            &solo(&f),
            &NG,
            &DATE,
            &(KVI_VALUE_MAX + 1),
            &BASKET,
            &PERIOD_START,
            &PERIOD_END
        ),
        Err(Ok(Error::ValueOutOfRange))
    );

    assert_eq!(
        f.client.try_set_daily_index(
            &solo(&f),
            &NG,
            &DATE,
            &(-KVI_VALUE_MAX - 1),
            &BASKET,
            &PERIOD_START,
            &PERIOD_END
        ),
        Err(Ok(Error::ValueOutOfRange))
    );

    assert_eq!(f.client.get_daily_index(&NG, &DATE), None);
}

#[test]
fn a_value_out_of_bounds_emits_no_event() {
    let f = deploy_initialized();

    assert!(f
        .client
        .try_set_daily_index(
            &solo(&f),
            &NG,
            &DATE,
            &(KVI_VALUE_MAX + 1),
            &BASKET,
            &PERIOD_START,
            &PERIOD_END
        )
        .is_err());

    assert_eq!(emitted_count(&f), 0);
}

#[test]
fn the_boundary_values_are_storable() {
    let f = deploy_initialized();

    f.client.set_daily_index(
        &solo(&f),
        &NG,
        &DATE,
        &KVI_VALUE_MAX,
        &BASKET,
        &PERIOD_START,
        &PERIOD_END,
    );
    f.client.set_daily_index(
        &solo(&f),
        &NG,
        &(DATE + 1),
        &(-KVI_VALUE_MAX),
        &BASKET,
        &PERIOD_START,
        &PERIOD_END,
    );

    assert_eq!(
        f.client.get_daily_index(&NG, &DATE).unwrap().value,
        KVI_VALUE_MAX
    );
    assert_eq!(
        f.client.get_daily_index(&NG, &(DATE + 1)).unwrap().value,
        -KVI_VALUE_MAX
    );
}

/// The baseline value (100.0000) is an ordinary storable number, which is
/// what lets the first published day of a country serve as its reference.
#[test]
fn the_baseline_value_is_storable() {
    let f = deploy_initialized();

    f.client.set_daily_index(
        &solo(&f),
        &NG,
        &DATE,
        &KVI_BASELINE,
        &BASKET,
        &PERIOD_START,
        &PERIOD_END,
    );

    assert_eq!(
        f.client.get_daily_index(&NG, &DATE).unwrap().value,
        KVI_BASELINE
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// CT-032 — deterministic aggregation (#507)
// ═══════════════════════════════════════════════════════════════════════════

/// Observations with unit weights, from plain values.
fn observations(f: &Fixture, values: &[i128]) -> Vec<Observation> {
    let mut out = Vec::new(&f.env);
    for value in values {
        out.push_back(Observation {
            value: *value,
            weight: 1,
        });
    }
    out
}

/// Observations from `(value, weight)` pairs.
fn weighted(f: &Fixture, pairs: &[(i128, u32)]) -> Vec<Observation> {
    let mut out = Vec::new(&f.env);
    for (value, weight) in pairs {
        out.push_back(Observation {
            value: *value,
            weight: *weight,
        });
    }
    out
}

#[test]
fn the_median_of_an_odd_count_is_the_middle_value() {
    let f = deploy_initialized();

    assert_eq!(
        f.client
            .compute_daily_index(&observations(&f, &[10, 20, 30])),
        20
    );
    assert_eq!(
        f.client
            .compute_daily_index(&observations(&f, &[30, 10, 20])),
        20
    );
}

#[test]
fn the_median_of_an_even_count_averages_the_two_middle_values() {
    let f = deploy_initialized();

    // (20 + 30) / 2 = 25
    assert_eq!(
        f.client
            .compute_daily_index(&observations(&f, &[10, 20, 30, 40])),
        25
    );

    // (11 + 12) / 2 = 11.5 -> 12, half away from zero (CT-031)
    assert_eq!(
        f.client
            .compute_daily_index(&observations(&f, &[10, 11, 12, 13])),
        12
    );

    // Negative halves round away from zero too: (-11 + -12) / 2 = -11.5 -> -12
    assert_eq!(
        f.client
            .compute_daily_index(&observations(&f, &[-13, -12, -11, -10])),
        -12
    );
}

/// Outlier semantics: with 10 observations the 10% trim drops the single
/// lowest and single highest, so one wild value at each end changes nothing.
#[test]
fn outliers_are_trimmed_before_the_median() {
    let f = deploy_initialized();

    let obs = observations(&f, &[1, 100, 100, 100, 100, 100, 100, 100, 100, 1000]);
    assert_eq!(f.client.compute_daily_index(&obs), 100);
}

#[test]
fn weights_pull_the_median_toward_them() {
    let f = deploy_initialized();

    // Unweighted median of {10, 20, 30} is 20, but with 30 carrying most of
    // the weight the weighted median is 30.
    let obs = weighted(&f, &[(10, 1), (20, 1), (30, 8)]);
    assert_eq!(f.client.compute_daily_index(&obs), 30);

    // A heavily weighted middle observation is picked outright.
    let obs = weighted(&f, &[(10, 1), (20, 6), (30, 1)]);
    assert_eq!(f.client.compute_daily_index(&obs), 20);
}

/// Tie behaviour: equal values are interchangeable, and an even split on
/// equal values returns that value.
#[test]
fn ties_between_equal_values_are_stable() {
    let f = deploy_initialized();

    assert_eq!(
        f.client
            .compute_daily_index(&observations(&f, &[7, 7, 7, 7])),
        7
    );
    assert_eq!(
        f.client.compute_daily_index(&observations(&f, &[3, 3, 3])),
        3
    );
}

/// Determinism: the same multiset in a different order yields the same value.
#[test]
fn identical_inputs_in_any_order_give_the_identical_result() {
    let f = deploy_initialized();

    let a = observations(&f, &[1, 5, 2, 9, 4, 8, 3, 7, 6]);
    let b = observations(&f, &[9, 1, 8, 2, 7, 3, 6, 4, 5]);

    assert_eq!(
        f.client.compute_daily_index(&a),
        f.client.compute_daily_index(&b)
    );
}

#[test]
fn aggregating_no_observations_is_rejected() {
    let f = deploy_initialized();

    assert_eq!(
        f.client.try_compute_daily_index(&Vec::new(&f.env)),
        Err(Ok(Error::EmptyObservations))
    );
}

#[test]
fn a_zero_weight_observation_is_rejected() {
    let f = deploy_initialized();

    let obs = weighted(&f, &[(10, 1), (20, 0)]);
    assert_eq!(
        f.client.try_compute_daily_index(&obs),
        Err(Ok(Error::ZeroWeight))
    );
}

#[test]
fn an_out_of_bounds_observation_is_rejected() {
    let f = deploy_initialized();

    let obs = weighted(&f, &[(KVI_VALUE_MAX + 1, 1), (20, 1)]);
    assert_eq!(
        f.client.try_compute_daily_index(&obs),
        Err(Ok(Error::ValueOutOfRange))
    );
}

/// The aggregated entrypoint stores the computed median and emits the same
/// CT-035 event, so a consumer acting on the event sees the aggregate.
#[test]
fn the_aggregated_entrypoint_stores_the_computed_value_and_emits_the_event() {
    let f = deploy_initialized();

    let obs = observations(&f, &[10, 20, 30, 40]);
    let computed = f.client.set_aggregated_index(
        &solo(&f),
        &NG,
        &DATE,
        &obs,
        &BASKET,
        &PERIOD_START,
        &PERIOD_END,
    );

    assert_eq!(computed, 25);

    // Capture the event before any further invocation replaces the buffer.
    assert_eq!(emitted_count(&f), 1);
    let expected = DailyIndexUpdated {
        country: NG,
        date: DATE,
        value: 25,
        basket_version: BASKET,
        source_period_start: PERIOD_START,
        source_period_end: PERIOD_END,
        updater: f.updater.clone(),
        schema_version: SCHEMA_VERSION,
    };
    assert_eq!(f.env.events().all(), expected_event(&f, &expected));

    let stored = f.client.get_daily_index(&NG, &DATE).unwrap();
    assert_eq!(stored.value, 25);
    assert_eq!(stored.basket_version, BASKET);
    assert_eq!(stored.updater, f.updater.clone());
}

/// The aggregated path shares the CT-033 immutable-history guard.
#[test]
fn the_aggregated_entrypoint_enforces_immutable_history() {
    let f = deploy_initialized();
    let obs = observations(&f, &[10, 20, 30]);

    f.client.set_aggregated_index(
        &solo(&f),
        &NG,
        &DATE,
        &obs,
        &BASKET,
        &PERIOD_START,
        &PERIOD_END,
    );

    assert_eq!(
        f.client.try_set_aggregated_index(
            &solo(&f),
            &NG,
            &DATE,
            &obs,
            &BASKET,
            &PERIOD_START,
            &PERIOD_END
        ),
        Err(Ok(Error::IndexAlreadyFinalized))
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// CT-033 — reject duplicate index updates (#508)
// ═══════════════════════════════════════════════════════════════════════════

/// A duplicate of an already-finalized day is a replay and must fail, even
/// with a different value.
#[test]
fn replaying_the_same_day_is_rejected() {
    let f = deploy_initialized();
    set_index(&f);

    assert_eq!(
        f.client.try_set_daily_index(
            &solo(&f),
            &NG,
            &DATE,
            &(VALUE + 1),
            &BASKET,
            &PERIOD_START,
            &PERIOD_END
        ),
        Err(Ok(Error::IndexAlreadyFinalized))
    );

    // The original record is untouched — history is immutable.
    assert_eq!(f.client.get_daily_index(&NG, &DATE).unwrap().value, VALUE);
}

#[test]
fn a_rejected_replay_emits_no_event() {
    let f = deploy_initialized();
    set_index(&f);

    assert!(f
        .client
        .try_set_daily_index(
            &solo(&f),
            &NG,
            &DATE,
            &(VALUE + 1),
            &BASKET,
            &PERIOD_START,
            &PERIOD_END
        )
        .is_err());

    assert_eq!(emitted_count(&f), 0);
}

/// Backdating: once a later day is finalized, an earlier day cannot be
/// written, and the rejected write stores nothing.
#[test]
fn backdating_after_a_later_day_is_rejected() {
    let f = deploy_initialized();
    set_index(&f); // NG@DATE

    f.client.set_daily_index(
        &solo(&f),
        &NG,
        &(DATE + 1),
        &VALUE,
        &BASKET,
        &PERIOD_START,
        &PERIOD_END,
    );

    assert_eq!(
        f.client.try_set_daily_index(
            &solo(&f),
            &NG,
            &(DATE - 1),
            &VALUE,
            &BASKET,
            &PERIOD_START,
            &PERIOD_END
        ),
        Err(Ok(Error::OutOfOrderUpdate))
    );
    assert_eq!(f.client.get_daily_index(&NG, &(DATE - 1)), None);
}

/// History is strictly forward: a gap cannot be backfilled once a later day
/// exists — a missed day simply has no index.
#[test]
fn a_gap_cannot_be_backfilled() {
    let f = deploy_initialized();
    set_index(&f); // NG@DATE
    f.client.set_daily_index(
        &solo(&f),
        &NG,
        &(DATE + 2),
        &VALUE,
        &BASKET,
        &PERIOD_START,
        &PERIOD_END,
    );

    assert_eq!(
        f.client.try_set_daily_index(
            &solo(&f),
            &NG,
            &(DATE + 1),
            &VALUE,
            &BASKET,
            &PERIOD_START,
            &PERIOD_END
        ),
        Err(Ok(Error::OutOfOrderUpdate))
    );
}

/// Immutability is per country: finalizing one country's day does not lock
/// any other country's calendar.
#[test]
fn immutability_is_per_country() {
    let f = deploy_initialized();
    set_index(&f); // NG@DATE

    f.client.set_daily_index(
        &solo(&f),
        &symbol_short!("KE"),
        &DATE,
        &VALUE,
        &BASKET,
        &PERIOD_START,
        &PERIOD_END,
    );

    assert_eq!(
        f.client
            .get_daily_index(&symbol_short!("KE"), &DATE)
            .unwrap()
            .value,
        VALUE
    );
}

/// Strictly increasing days are accepted; this pins the forward rule that
/// the out-of-order check implements.
#[test]
fn strictly_increasing_days_are_accepted() {
    let f = deploy_initialized();

    f.client.set_daily_index(
        &solo(&f),
        &NG,
        &DATE,
        &100,
        &BASKET,
        &PERIOD_START,
        &PERIOD_END,
    );
    f.client.set_daily_index(
        &solo(&f),
        &NG,
        &(DATE + 1),
        &200,
        &BASKET,
        &PERIOD_START,
        &PERIOD_END,
    );
    f.client.set_daily_index(
        &solo(&f),
        &NG,
        &(DATE + 2),
        &300,
        &BASKET,
        &PERIOD_START,
        &PERIOD_END,
    );

    assert_eq!(
        f.client.get_daily_index(&NG, &(DATE + 2)).unwrap().value,
        300
    );
}
