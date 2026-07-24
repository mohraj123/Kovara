# Kovara Mini Readme

This document defines the readme event schema for the Kovara Social contract. Indexers and clients should use this as the source of truth for decoding and filtering events.

## Versioning Strategy

All events follow a consistent topic structure:
`(ContractName, EventName, Version)`

- **ContractName**: `Kovara` (Symbol)
- **EventName**: Descriptive name (Symbol)
- **Version**: `v1`, `v2`, etc. (Symbol)

When a schema change is required, the version symbol will be incremented. Indexers should filter for the versions they support.

## Canonical Events

### ProfileSet

Emitted when a user creates or updates their profile.

- **Topic 0**: `Kovara`
- **Topic 1**: `profile`
- **Topic 2**: `v1`
- **Data Payload**: `ProfileSetEvent`
  - `user`: `Address`
  - `username`: `String`

### Follow

Emitted when a user follows another user.

- **Topic 0**: `Kovara`
- **Topic 1**: `follow`
- **Topic 2**: `v1`
- **Data Payload**: `FollowEvent`
  - `follower`: `Address`
  - `followee`: `Address`

### Unfollow

Emitted when a user unfollows another user.

- **Topic 0**: `Kovara`
- **Topic 1**: `unfollow`
- **Topic 2**: `v1`
- **Data Payload**: `UnfollowEvent`
  - `follower`: `Address`
  - `followee`: `Address`

### Block

Emitted when a user blocks another user.

- **Topic 0**: `Kovara`
- **Topic 1**: `block`
- **Topic 2**: `v1`
- **Data Payload**: `BlockEvent`
  - `blocker`: `Address`
  - `blocked`: `Address`

### Unblock

Emitted when a user unblocks another user.

- **Topic 0**: `Kovara`
- **Topic 1**: `unblock`
- **Topic 2**: `v1`
- **Data Payload**: `UnblockEvent`
  - `blocker`: `Address`
  - `blocked`: `Address`

### PostCreated

Emitted when a new post is successfully created.

- **Topic 0**: `Kovara`
- **Topic 1**: `post`
- **Topic 2**: `v1`
- **Data Payload**: `PostCreatedEvent`
  - `id`: `u64`
  - `author`: `Address`

### Tip

Emitted when a post author is tipped.

- **Topic 0**: `Kovara`
- **Topic 1**: `tip`
- **Topic 2**: `v1`
- **Data Payload**: `TipEvent`
  - `tipper`: `Address`
  - `post_id`: `u64`
  - `amount`: `i128` (Gross amount)
  - `fee`: `i128` (Amount sent to protocol treasury)

### Like

Emitted when a user likes a post.

- **Topic 0**: `Kovara`
- **Topic 1**: `like`
- **Topic 2**: `v1`
- **Data Payload**: `LikePostEvent`
  - `user`: `Address`
  - `post_id`: `u64`

### ContractUpgraded

Emitted when the contract WASM is upgraded.

- **Topic 0**: `Kovara`
- **Topic 1**: `upgraded`
- **Topic 2**: `v1`
- **Data Payload**: `ContractUpgraded`
  - `new_wasm_hash`: `BytesN<32>`

#### Upgrade preconditions

`ContractUpgraded` is only emitted when all of the following hold:

1. The contract is **initialized** — the `ADMIN` key exists in instance storage.
   An uninitialized contract panics with `"not initialized"` before the event is
   published.
2. The caller is the **stored admin address** — `require_auth()` is satisfied.
   Any other caller is rejected before the event is published.
3. The `new_wasm_hash` refers to a WASM blob **already uploaded** to the Stellar
   ledger. The Soroban host validates the hash; if no matching blob is found the
   host raises an error and the event is **not** committed to the ledger (it may
   appear only in the failed-diagnostic-events log).

Because event emission occurs inside the contract (before the host finalises the
WASM swap), a test environment with no uploaded WASM will show the event in
`env.events().all()` only if the panic is caught. In production, the event is
committed only when the full transaction succeeds.

#### Invalid / missing WASM hash behaviour

| Supplied hash                              | Upload status     | Outcome                                                |
| ------------------------------------------ | ----------------- | ------------------------------------------------------ |
| Any `BytesN<32>` not in the ledger         | Not uploaded      | Host error; transaction fails; event **not** committed |
| `[0u8; 32]` (all zeros)                    | Never a real hash | Same as above                                          |
| `[0xffu8; 32]` (all 0xff)                  | Never a real hash | Same as above                                          |
| Hash returned by `stellar contract upload` | Uploaded          | Transaction succeeds; event committed                  |

#### Monitoring recommendations

Indexers should subscribe to this event to detect unexpected upgrades:

- Alert if a `ContractUpgraded` event appears from an unknown admin address.
- Alert if the `new_wasm_hash` does not match the hash recorded in the release
  notes for the expected deployment.
- Record every upgrade with its ledger sequence number for audit purposes.

### PostDeleted

Emitted when a post is deleted by its author.

- **Topic 0**: `Kovara`
- **Topic 1**: `post_del`
- **Topic 2**: `v1`
- **Data Payload**: `PostDeleted`
  - `post_id`: `u64`
  - `author`: `Address`

### PoolDeposit

Emitted when tokens are deposited into a community pool.

- **Topic 0**: `Kovara`
- **Topic 1**: `deposit`
- **Topic 2**: `v1`
- **Data Payload**: `PoolDepositEvent`
  - `depositor`: `Address`
  - `pool_id`: `Symbol`
  - `amount`: `i128`

### PoolWithdraw

Emitted when tokens are withdrawn from a community pool.

- **Topic 0**: `Kovara`
- **Topic 1**: `withdraw`
- **Topic 2**: `v1`
- **Data Payload**: `PoolWithdrawEvent`
  - `recipient`: `Address`
  - `pool_id`: `Symbol`
  - `amount`: `i128`

### PoolCreated

Emitted when a new community pool is created.

- **Topic 0**: `Kovara`
- **Topic 1**: `pool_created`
- **Topic 2**: `v1`
- **Data Payload**: `PoolCreatedEvent`
  - `pool_id`: `Symbol`
  - `token`: `Address`
  - `admins`: `Address[]`
  - `threshold`: `u32`

### PoolAdminAdded

Emitted when a new admin is added to a pool.

- **Topic 0**: `Kovara`
- **Topic 1**: `admin_add`
- **Topic 2**: `v1`
- **Data Payload**: `PoolAdminAddedEvent`
  - `pool_id`: `Symbol`
  - `new_admin`: `Address`

### PoolAdminRemoved

Emitted when an admin is removed from a pool.

- **Topic 0**: `Kovara`
- **Topic 1**: `admin_rm`
- **Topic 2**: `v1`
- **Data Payload**: `PoolAdminRemovedEvent`
  - `pool_id`: `Symbol`
  - `removed_admin`: `Address`

### PoolThresholdUpdated

Emitted when a pool's signature threshold is updated.

- **Topic 0**: `Kovara`
- **Topic 1**: `threshold`
- **Topic 2**: `v1`
- **Data Payload**: `PoolThresholdUpdatedEvent`
  - `pool_id`: `Symbol`
  - `old_threshold`: `u32`
  - `new_threshold`: `u32`

### FeeUpdated

Emitted when the admin updates the protocol fee.

- **Topic 0**: `Kovara`
- **Topic 1**: `fee_updated_event`
- **Topic 2**: `v1`
- **Data Payload**: `FeeUpdatedEvent`
  - `old_fee_bps`: `u32`
  - `new_fee_bps`: `u32`

### TreasuryUpdated

Emitted when the admin updates the protocol treasury address.

- **Topic 0**: `Kovara`
- **Topic 1**: `treasury_updated_event`
- **Topic 2**: `v1`
- **Data Payload**: `TreasuryUpdatedEvent`
  - `old_treasury`: `Address`
  - `new_treasury`: `Address`

## Querying and Decoding

### Using Stellar CLI

To fetch events from a specific contract on Testnet:

```bash
stellar events --id <CONTRACT_ID> --network testnet --start-ledger <LEDGER_NUM>
```

To filter for only `tip` events:

```bash
stellar events --id <CONTRACT_ID> --network testnet --topic "Kovara, tip, v1"
```

### Using JS SDK

```javascript
const events = await server.getEvents({
  filters: [
    {
      type: "contract",
      contractIds: [CONTRACT_ID],
      topics: [
        [
          xdr.ScVal.scvSymbol("Kovara").toXDR("base64"),
          xdr.ScVal.scvSymbol("tip").toXDR("base64"),
          xdr.ScVal.scvSymbol("v1").toXDR("base64"),
        ],
      ],
    },
  ],
  startLedger: 123456,
});
```
