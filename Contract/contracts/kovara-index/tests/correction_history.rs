#![cfg(test)]

use kovara_index::{CorrectionRecord, KovaraIndex, KovaraIndexClient};
use soroban_sdk::{testutils::Address as _, Address, Env, String};

fn setup() -> (Env, KovaraIndexClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, KovaraIndex);
    let client = KovaraIndexClient::new(&env, &contract_id);
    let governance = Address::generate(&env);
    client.initialize(&governance);
    (env, client, governance)
}

#[test]
fn correction_appends_history_with_old_and_new_values() {
    let (env, client, governance) = setup();
    client.publish(&20250101u64, &1000i128);

    let reason = String::from_str(&env, "oracle feed error");
    client.correct(&governance, &20250101u64, &1100i128, &reason);

    let history = client.correction_history(&20250101u64);
    assert_eq!(history.len(), 1);
    let rec: CorrectionRecord = history.get(0).unwrap();
    assert_eq!(rec.old_value, 1000i128);
    assert_eq!(rec.new_value, 1100i128);
    assert_eq!(rec.reason, reason);
    assert_eq!(client.get(&20250101u64), 1100i128);
}

#[test]
fn history_is_append_only_across_multiple_corrections() {
    let (env, client, governance) = setup();
    client.publish(&20250102u64, &500i128);

    client.correct(&governance, &20250102u64, &510i128, &String::from_str(&env, "first"));
    client.correct(&governance, &20250102u64, &520i128, &String::from_str(&env, "second"));

    let history = client.correction_history(&20250102u64);
    assert_eq!(history.len(), 2);
    let first = history.get(0).unwrap();
    let second = history.get(1).unwrap();
    assert_eq!(first.old_value, 500i128);
    assert_eq!(first.new_value, 510i128);
    assert_eq!(second.old_value, 510i128);
    assert_eq!(second.new_value, 520i128);
    assert_eq!(second.reason, String::from_str(&env, "second"));
}

#[test]
fn rejected_correction_leaves_history_and_value_unchanged() {
    let (env, client, _governance) = setup();
    client.publish(&20250103u64, &700i128);

    let outsider = Address::generate(&env);
    let result = client.try_correct(&outsider, &20250103u64, &999i128, &String::from_str(&env, "bad"));
    assert!(result.is_err());

    assert_eq!(client.get(&20250103u64), 700i128);
    assert_eq!(client.correction_history(&20250103u64).len(), 0);
}
