diff --git a/Contract/contracts/kovara-index/src/lib.rs b/Contract/contracts/kovara-index/src/lib.rs
--- a/Contract/contracts/kovara-index/src/lib.rs
+++ b/Contract/contracts/kovara-index/src/lib.rs
@@ -48,8 +48,10 @@
 pub enum DataKey {
     /// `(country, date)` → daily index value.
     DailyIndex(Symbol, u64),
     /// `(country, date)` → the window the written value came from.
     DailyWindow(Symbol, u64),
+    /// Country → date of the latest daily index value.
+    LatestDate(Symbol),
 }
 
 #[contract]
@@ -69,12 +71,38 @@ impl KovaraIndex {
         }
         updater.require_auth();
         env.storage()
             .persistent()
-            .set(&DataKey::DailyIndex(country, date), &value);
+            .set(&DataKey::DailyIndex(country.clone(), date), &value);
+
+        // Track the latest date independently for each country.
+        let latest_date: Option<u64> = env
+            .storage()
+            .persistent()
+            .get(&DataKey::LatestDate(country.clone()));
+
+        if latest_date.map_or(true, |latest| date > latest) {
+            env.storage()
+                .persistent()
+                .set(&DataKey::LatestDate(country), &date);
+        }
+
         Ok(())
     }
+
     /// Read a stored daily index value, if present.
     pub fn get_daily_index(env: Env, country: Symbol, date: u64) -> Option<i128> {
         env.storage().persistent().get(&DataKey::DailyIndex(country, date))
     }
+
+    /// Return the latest date and its corresponding daily index value.
+    ///
+    /// Returns `None` when this country has no recorded daily index.
+    pub fn get_latest_daily_index(env: Env, country: Symbol) -> Option<(u64, i128)> {
+        let date: u64 = env
+            .storage()
+            .persistent()
+            .get(&DataKey::LatestDate(country.clone()))?;
+
+        let value: i128 = env
+            .storage()
+            .persistent()
+            .get(&DataKey::DailyIndex(country, date))?;
+
+        Some((date, value))
+    }
+
@@ -146,9 +169,20 @@ impl KovaraIndex {
         env.storage()
             .persistent()
             .set(&DataKey::DailyIndex(country.clone(), date), &value);
         env.storage()
             .persistent()
-            .set(&DataKey::DailyWindow(country, date), &(valid_from, valid_until));
+            .set(
+                &DataKey::DailyWindow(country.clone(), date),
+                &(valid_from, valid_until),
+            );
+
+        // Windowed writes maintain the same latest-date index.
+        let latest_date: Option<u64> = env
+            .storage()
+            .persistent()
+            .get(&DataKey::LatestDate(country.clone()));
+
+        if latest_date.map_or(true, |latest| date > latest) {
+            env.storage()
+                .persistent()
+                .set(&DataKey::LatestDate(country), &date);
+        }
 
         Ok(())
     }
@@ -193,8 +226,50 @@ mod tests {
         )
     }
 
+    #[test]
+    fn latest_daily_index_returns_none_for_empty_history() {
+        let env = Env::default();
+        let (client, _) = deploy(&env);
+        let country = Symbol::new(&env, "NG");
+
+        assert_eq!(client.get_latest_daily_index(&country), None);
+    }
+
+    #[test]
+    fn latest_daily_index_returns_matching_value_and_tracks_each_country() {
+        let env = Env::default();
+        let (client, updater) = deploy(&env);
+        let country = Symbol::new(&env, "NG");
+        let other_country = Symbol::new(&env, "GH");
+
+        env.mock_all_auths();
+
+        // Insert dates out of order.
+        client.set_daily_index(&updater, &country, &20, &200);
+        client.set_daily_index(&updater, &country, &10, &100);
+
+        assert_eq!(
+            client.get_latest_daily_index(&country),
+            Some((20, 200))
+        );
+
+        // A later windowed record advances the latest date.
+        client.set_daily_index_windowed(
+            &updater,
+            &country,
+            &30,
+            &300,
+            &100,
+            &200,
+            &150,
+        );
+
+        assert_eq!(
+            client.get_latest_daily_index(&country),
+            Some((30, 300))
+        );
+
+        // An older write must not move the latest date backward.
+        client.set_daily_index(&updater, &country, &20, &250);
+
+        assert_eq!(
+            client.get_latest_daily_index(&country),
+            Some((30, 300))
+        );
+
+        // Updating the latest date returns its updated value.
+        client.set_daily_index(&updater, &country, &30, &350);
+
+        assert_eq!(
+            client.get_latest_daily_index(&country),
+            Some((30, 350))
+        );
+
+        // Each country has an independent latest date.
+        client.set_daily_index(&updater, &other_country, &5, &500);
+
+        assert_eq!(
+            client.get_latest_daily_index(&other_country),
+            Some((5, 500))
+        );
+
+        assert_eq!(
+            client.get_latest_daily_index(&country),
+            Some((30, 350))
+        );
+    }
+
     #[test]
     fn freshness_is_half_open() {
         let env = Env::default();
         let (client, _) = deploy(&env);
         // Lower bound inclusive.
diff --git a/Contract/README.md b/Contract/README.md
--- a/Contract/README.md
+++ b/Contract/README.md
@@ -215,5 +215,29 @@
 Reads: `is_fresh(valid_from, valid_until, query_ts)` is the pure predicate,
 `get_daily_window` returns the window an entry was written under, and
 `get_fresh_daily_index` returns the value only while that window is still fresh.
 `None` from `get_daily_window` means "written without a window" — which
 `get_daily_index` still returns, so the raw record stays auditable.
+
+### Latest daily index by country
+
+`get_latest_daily_index(country)` returns `Some((date, value))` for the latest
+recorded daily index, or `None` when the country has no recorded index.
+
+The contract maintains a persistent `LatestDate(country)` entry when either
+`set_daily_index` or `set_daily_index_windowed` stores a value. The date advances
+only when a greater date is written; updates to older dates cannot move it
+backwards. Each country has an independent latest-date entry.
+
+Example:
+
+```rust
+let country = Symbol::new(&env, "NG");
+match client.get_latest_daily_index(&country) {
+    Some((date, value)) => {
+        // Use the latest date and its corresponding index value.
+    }
+    None => {
+        // No index history exists for this country.
+    }
+}
+```
