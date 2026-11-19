//! #1083 CT-012 — versioned history cursor.
#![cfg(test)]

use kovara_price_vault::{Error, HistoryCursor, HISTORY_CURSOR_VERSION};

#[test]
fn round_trip_current_version() {
    let c = HistoryCursor::new(42);
    assert_eq!(c.version, HISTORY_CURSOR_VERSION);
    assert_eq!(c.validate().unwrap(), 42);
}

#[test]
fn unknown_version_rejected() {
    assert_eq!(
        HistoryCursor {
            version: 99,
            offset: 0
        }
        .validate()
        .unwrap_err(),
        Error::UnsupportedCursorVersion
    );
    assert_eq!(
        HistoryCursor {
            version: 0,
            offset: 1
        }
        .validate()
        .unwrap_err(),
        Error::UnsupportedCursorVersion
    );
}
