//! Tests for CT-049: KovaraIndex history pagination.
//!
//! Verifies that `get_history` returns stable cursor-based pages of daily
//! dates in ascending order, and that invalid cursors are rejected.

use crate::{Error, HistoryPage, KovaraIndex, KovaraIndexClient, MAX_PAGE_SIZE};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{symbol_short, vec, Address, Env, Symbol, Vec};

struct Fixture<'a> {
    env: Env,
    client: KovaraIndexClient<'a>,
    admin: Address,
    updater: Address,
}

fn deploy_initialized() -> Fixture<'static> {
    let env = Env::default();
    let contract_id = env.register(KovaraIndex, ());
    let client = KovaraIndexClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let updater = Address::generate(&env);

    env.mock_all_auths();

    client.initialize(&admin);
    client.set_sentinels(&admin, &vec![&env, updater.clone()], &1);

    Fixture {
        env,
        client,
        admin,
        updater,
    }
}

const NG: Symbol = symbol_short!("NG");
const KE: Symbol = symbol_short!("KE");
const BASKET: u32 = 3;
const PS: u64 = 1_700_000_000;
const PE: u64 = 1_700_086_400;

fn write(f: &Fixture, country: Symbol, date: u64, value: i128) {
    f.client.set_daily_index(
        &vec![&f.env, f.updater.clone()],
        &country,
        &date,
        &value,
        &BASKET,
        &PS,
        &PE,
        &vec![&f.env, symbol_short!("food")],
    );
}

/// A country with no history returns an empty page and no next cursor.
#[test]
fn history_is_empty_before_any_writes() {
    let f = deploy_initialized();

    let page = f.client.get_history(&NG, &None);

    assert!(page.dates.is_empty());
    assert_eq!(page.next_cursor, None);
}

/// Dates appear in ascending order regardless of write order.
#[test]
fn dates_are_returned_in_ascending_order() {
    let f = deploy_initialized();

    // Write out of order.
    write(&f, NG, 20_143, 300);
    write(&f, NG, 20_141, 100);
    write(&f, NG, 20_142, 200);

    let page = f.client.get_history(&NG, &None);

    assert_eq!(page.dates.len(), 3);
    assert_eq!(page.dates.get(0).unwrap(), 20_141);
    assert_eq!(page.dates.get(1).unwrap(), 20_142);
    assert_eq!(page.dates.get(2).unwrap(), 20_143);
}

/// Cursor `None` starts at the beginning.
#[test]
fn none_cursor_starts_at_beginning() {
    let f = deploy_initialized();

    write(&f, NG, 20_140, 100);
    write(&f, NG, 20_141, 200);

    let page_none = f.client.get_history(&NG, &None);
    let page_zero = f.client.get_history(&NG, &Some(0));

    assert_eq!(page_none.dates, page_zero.dates);
    assert_eq!(page_none.dates.get(0).unwrap(), 20_140);
}

/// When more dates exist than the page size, `next_cursor` points past the
/// returned slice so the caller can fetch the next page.
#[test]
fn pagination_continues_with_next_cursor() {
    let f = deploy_initialized();

    // Write MAX_PAGE_SIZE + 5 dates.
    let total = (MAX_PAGE_SIZE + 5) as u64;
    for i in 0..total {
        write(&f, NG, 20_000 + i, i as i128);
    }

    let page1 = f.client.get_history(&NG, &None);

    assert_eq!(page1.dates.len(), MAX_PAGE_SIZE);
    assert_eq!(page1.next_cursor, Some(MAX_PAGE_SIZE));

    let page2 = f.client.get_history(&NG, &page1.next_cursor);

    assert_eq!(page2.dates.len(), 5);
    assert_eq!(page2.next_cursor, None);

    // Pages are contiguous and cover all dates.
    assert_eq!(page1.dates.get(0).unwrap(), 20_000);
    assert_eq!(page2.dates.get(0).unwrap(), 20_000 + MAX_PAGE_SIZE as u64);
}

/// Exactly MAX_PAGE_SIZE dates: one full page, no next cursor.
#[test]
fn exactly_one_full_page_has_no_next_cursor() {
    let f = deploy_initialized();

    for i in 0..MAX_PAGE_SIZE as u64 {
        write(&f, NG, 20_000 + i, i as i128);
    }

    let page = f.client.get_history(&NG, &None);

    assert_eq!(page.dates.len(), MAX_PAGE_SIZE);
    assert_eq!(page.next_cursor, None);
}

/// A cursor equal to the list length is out of range.
#[test]
fn cursor_at_list_length_is_rejected() {
    let f = deploy_initialized();

    write(&f, NG, 20_140, 100);
    write(&f, NG, 20_141, 200);

    // 2 dates → cursor 2 is out of range.
    assert_eq!(
        f.client.try_get_history(&NG, &Some(2)),
        Err(Ok(Error::InvalidCursor))
    );
}

/// A cursor well past the end is rejected.
#[test]
fn cursor_well_past_end_is_rejected() {
    let f = deploy_initialized();

    write(&f, NG, 20_140, 100);

    assert_eq!(
        f.client.try_get_history(&NG, &Some(999)),
        Err(Ok(Error::InvalidCursor))
    );
}

/// Each country has its own independent history.
#[test]
fn history_is_per_country() {
    let f = deploy_initialized();

    write(&f, NG, 20_140, 100);
    write(&f, NG, 20_141, 200);
    write(&f, KE, 20_200, 300);

    let ng_page = f.client.get_history(&NG, &None);
    let ke_page = f.client.get_history(&KE, &None);

    assert_eq!(ng_page.dates.len(), 2);
    assert_eq!(ke_page.dates.len(), 1);
    assert_eq!(ke_page.dates.get(0).unwrap(), 20_200);
}

/// Re-writing the same date does not add a duplicate entry to the history.
#[test]
fn overwriting_a_date_does_not_duplicate_it_in_history() {
    let f = deploy_initialized();

    write(&f, NG, 20_140, 100);
    write(&f, NG, 20_140, 999); // overwrite same date

    let page = f.client.get_history(&NG, &None);

    assert_eq!(page.dates.len(), 1);
    assert_eq!(page.dates.get(0).unwrap(), 20_140);
}

/// Cursor 0 on an empty history is valid (returns empty page).
#[test]
fn cursor_zero_on_empty_history_is_valid() {
    let f = deploy_initialized();

    let page = f.client.get_history(&NG, &Some(0));

    assert!(page.dates.is_empty());
    assert_eq!(page.next_cursor, None);
}
