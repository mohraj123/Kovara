use kovara_sentinel_pool::{
    SentinelPool, SentinelPoolClient, SlashEvidence, SlashRecord,
    MAX_APPEAL_EVIDENCE_REF_BYTES, MAX_APPEAL_EVIDENCE_REFS,
};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Bytes, Env, String, Symbol,
};

fn setup() -> (Env, Address, Address, Address, SlashEvidence) {
    let env = Env::default();
    let contract_id = env.register_contract(None, SentinelPool);
    let client = SentinelPoolClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let governance = Address::generate(&env);
    let sentinel = Address::generate(&env);
    let evidence = SlashEvidence {
        proof_ref: String::from_str(&env, "case-1"),
        uri: String::from_str(&env, "ipfs://kovara/original-proof"),
        content_hash: Bytes::from_slice(&env, &[0xab; 32]),
    };

    env.mock_all_auths();
    client.initialize(&admin, &governance, &100, &10, &2);
    client.set_appeal_window(&admin, &100);
    client.stake(&sentinel, &250);
    client.slash(
        &governance,
        &sentinel,
        &50,
        &evidence,
        &Symbol::new(&env, "fraud"),
    );

    (env, contract_id, sentinel, governance, evidence)
}

#[test]
fn appellant_can_append_bounded_references_before_the_deadline() {
    let (env, contract_id, sentinel, governance, evidence) = setup();
    let client = SentinelPoolClient::new(&env, &contract_id);
    let first = String::from_str(&env, "ipfs://kovara/appeal-1");
    let second = String::from_str(&env, "ipfs://kovara/appeal-2");

    client.append_appeal_evidence(&sentinel, &evidence.proof_ref, &first);
    client.append_appeal_evidence(&governance, &evidence.proof_ref, &second);

    let references = client.appeal_evidence(&evidence.proof_ref);
    assert_eq!(references.len(), 2);
    assert_eq!(references.get(0), Some(first));
    assert_eq!(references.get(1), Some(second));

    let too_long = String::from_bytes(
        &env,
        &[b'x'; (MAX_APPEAL_EVIDENCE_REF_BYTES + 1) as usize],
    );
    assert!(client
        .try_append_appeal_evidence(&sentinel, &evidence.proof_ref, &too_long)
        .is_err());

    for _ in 2..MAX_APPEAL_EVIDENCE_REFS {
        let reference = String::from_str(&env, "ipfs://kovara/more");
        client.append_appeal_evidence(&sentinel, &evidence.proof_ref, &reference);
    }
    let extra = String::from_str(&env, "ipfs://kovara/overflow");
    assert!(client
        .try_append_appeal_evidence(&sentinel, &evidence.proof_ref, &extra)
        .is_err());
}

#[test]
fn appending_evidence_after_the_deadline_is_refused() {
    let (env, contract_id, sentinel, _, evidence) = setup();
    let client = SentinelPoolClient::new(&env, &contract_id);
    let deadline = client
        .slash_record(&evidence.proof_ref)
        .expect("slash record exists")
        .appeal_deadline;
    env.ledger()
        .with_mut(|ledger| ledger.sequence_number = (deadline + 1) as u32);

    let reference = String::from_str(&env, "ipfs://kovara/late");
    assert!(client
        .try_append_appeal_evidence(&sentinel, &evidence.proof_ref, &reference)
        .is_err());
    assert_eq!(client.appeal_evidence(&evidence.proof_ref).len(), 0);
}

#[test]
fn a_non_party_cannot_append_appeal_evidence() {
    let (env, contract_id, _, _, evidence) = setup();
    let client = SentinelPoolClient::new(&env, &contract_id);
    let attacker = Address::generate(&env);
    let reference = String::from_str(&env, "ipfs://kovara/unauthorized");

    assert!(client
        .try_append_appeal_evidence(&attacker, &evidence.proof_ref, &reference)
        .is_err());
    assert_eq!(client.appeal_evidence(&evidence.proof_ref).len(), 0);
}

#[test]
fn supplementary_evidence_does_not_change_the_original_slash_proof() {
    let (env, contract_id, sentinel, _, evidence) = setup();
    let client = SentinelPoolClient::new(&env, &contract_id);
    let original: SlashRecord = client
        .slash_record(&evidence.proof_ref)
        .expect("slash record exists");
    let reference = String::from_str(&env, "ipfs://kovara/appeal");

    client.append_appeal_evidence(&sentinel, &evidence.proof_ref, &reference);

    let after = client
        .slash_record(&evidence.proof_ref)
        .expect("slash record still exists");
    assert_eq!(after.evidence, original.evidence);
    assert_eq!(after.evidence, evidence);
    assert_eq!(client.appeal_evidence(&evidence.proof_ref).len(), 1);
}
