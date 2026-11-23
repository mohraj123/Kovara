
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// Persistent storage key for a daily index.
    ///
    /// Logical key: `(DailyIndex, country, date)`.
    ///
    /// Compatibility contract:
    /// - `country` remains a Soroban `Symbol`.
    /// - `date` remains a `u64`.
    /// - The enum variant remains `DailyIndex`.
    /// - The tuple field order remains `(country, date)`.
    ///
    /// Soroban serializes this typed key for storage. Do not replace it with
    /// string concatenation or reorder its fields without an explicit storage
    /// migration. Existing persistent entries depend on this representation.
    DailyIndex(Symbol, u64),

    /// Persistent storage key for a daily index validity window.
    ///
    /// Logical key: `(DailyWindow, country, date)`.
    ///
    /// This is intentionally a separate variant from `DailyIndex`, so a
    /// value and its validity window cannot share the same typed storage key.
    /// Preserve the variant and field order for storage compatibility.
    DailyWindow(Symbol, u64),
}

#[cfg(test)]
mod key_encoding_tests {
    use super::*;
    use soroban_sdk::{Env, Symbol};

    #[test]
    fn same_country_and_date_produce_equal_typed_keys() {
        let env = Env::default();
        let country_a = Symbol::new(&env, "NG");
        let country_b = Symbol::new(&env, "NG");

        assert_eq!(
            DataKey::DailyIndex(country_a, 20261020),
            DataKey::DailyIndex(country_b, 20261020),
        );
    }

    #[test]
    fn different_countries_do_not_collide() {
        let env = Env::default();

        assert_ne!(
            DataKey::DailyIndex(Symbol::new(&env, "NG"), 20261020),
            DataKey::DailyIndex(Symbol::new(&env, "GH"), 20261020),
        );
    }

    #[test]
    fn different_dates_do_not_collide() {
        let env = Env::default();
        let country = Symbol::new(&env, "NG");

        assert_ne!(
            DataKey::DailyIndex(country.clone(), 20261020),
            DataKey::DailyIndex(country, 20261021),
        );
    }

    #[test]
    fn value_and_window_keys_are_distinct() {
        let env = Env::default();
        let country = Symbol::new(&env, "NG");

        assert_ne!(
            DataKey::DailyIndex(country.clone(), 20261020),
            DataKey::DailyWindow(country, 20261020),
        );
    }

    #[test]
    fn daily_index_and_window_keys_preserve_their_schema() {
        let env = Env::default();
        let country = Symbol::new(&env, "NG");

        // These assertions make the current typed key schema explicit.
        // Changing a variant or field type/order requires a migration review.
        assert_eq!(
            DataKey::DailyIndex(country.clone(), 1),
            DataKey::DailyIndex(country.clone(), 1),
        );

        assert_eq!(
            DataKey::DailyWindow(country.clone(), 1),
            DataKey::DailyWindow(country, 1),
        );
    }
}
