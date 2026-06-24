# SDK Error Handling

All errors thrown by the Kovara SDK are instances of `KovaraError` or one of its typed subclasses. Every subclass can be caught individually with `instanceof`, making it straightforward to show the right feedback for each failure mode.

---

## Error Hierarchy

```
KovaraError
├── NotFoundError           – resource does not exist on-chain
├── UnauthorizedError       – caller lacks permission
├── InsufficientBalanceError – not enough XLM or token allowance
├── CooldownError           – tipping cooldown has not expired
└── InvalidInputError       – parameter validation failed
```

`InvalidManifestError` (mini-apps only) also extends `KovaraError`.

---

## Error Classes

### `KovaraError`

Base class. Thrown when no specific subclass matches.

| Property        | Type                   | Description                                       |
| --------------- | ---------------------- | ------------------------------------------------- |
| `message`       | `string`               | Human-readable description                        |
| `name`          | `string`               | Always the subclass name (e.g. `"NotFoundError"`) |
| `originalError` | `unknown \| undefined` | The raw error from the RPC layer                  |

```ts
import { KovaraError } from "@kovara/sdk";

try {
  await client.getPost(999);
} catch (err) {
  if (err instanceof KovaraError) {
    console.error(err.name, err.message);
  }
}
```

---

### `NotFoundError`

Thrown when a post, pool, or profile does not exist on-chain.

**Triggers:** contract error messages matching `not found` or `does not exist`.

```ts
import { NotFoundError } from "@kovara/sdk";

const post = await client.getPost(999).catch((err) => {
  if (err instanceof NotFoundError) {
    return null; // treat as missing
  }
  throw err;
});
```

---

### `UnauthorizedError`

Thrown when the caller is not permitted to perform the operation.

**Common causes:**

- Editing or deleting another user's post (`only author`)
- Calling a pool admin function without admin role (`only admin` / `not admin`)
- Interacting with a user who has blocked you (`blocked`)

```ts
import { UnauthorizedError } from "@kovara/sdk";

try {
  const xdr = client.deletePost(otherUserAddress, postId);
  // ... sign and submit
} catch (err) {
  if (err instanceof UnauthorizedError) {
    alert("You are not allowed to delete this post.");
  }
}
```

---

### `InsufficientBalanceError`

Thrown when the account has insufficient XLM or has not approved enough token allowance for the operation.

**Triggers:** messages matching `allowance`, `insufficient allowance`, `balance`, `low balance`, or `insufficient balance`.

```ts
import { InsufficientBalanceError } from "@kovara/sdk";

try {
  const xdr = client.tip(senderAddress, postId, 50_000_000n);
  // ... sign and submit
} catch (err) {
  if (err instanceof InsufficientBalanceError) {
    alert("Not enough balance. Top up your wallet and try again.");
  }
}
```

---

### `CooldownError`

Thrown when a tip is attempted before the per-sender cooldown window has elapsed for a given post.

**Trigger:** contract error message matching `cooldown`.

```ts
import { CooldownError } from "@kovara/sdk";

try {
  const xdr = client.tip(senderAddress, postId, amount);
  // ... sign and submit
} catch (err) {
  if (err instanceof CooldownError) {
    alert("You already tipped this post recently. Please wait before tipping again.");
  }
}
```

---

### `InvalidInputError`

Thrown when parameters fail pre-flight validation inside the contract.

**Common causes:**

- Username is shorter than 3 or longer than 32 characters, or contains invalid characters
- Post content exceeds 500 characters
- Tip amount is zero or negative
- Pool threshold exceeds the number of admins

**Triggers:** messages matching `invalid`, `too long`, `must be positive`, or `cannot exceed`.

```ts
import { InvalidInputError } from "@kovara/sdk";

try {
  const xdr = client.createPost(address, "");
  // ... sign and submit
} catch (err) {
  if (err instanceof InvalidInputError) {
    alert(`Input error: ${err.message}`);
  }
}
```

---

### `InvalidManifestError`

Thrown by `validateManifest()` when a mini-app manifest fails JSON schema validation. Only relevant to mini-app developers.

```ts
import { validateManifest, InvalidManifestError } from "@kovara/sdk";

try {
  validateManifest(manifestJson);
} catch (err) {
  if (err instanceof InvalidManifestError) {
    console.error("Manifest invalid:", err.message);
  }
}
```

---

## Catching All Errors

For a catch-all handler that still differentiates known errors from unexpected ones:

```ts
import {
  KovaraError,
  NotFoundError,
  UnauthorizedError,
  InsufficientBalanceError,
  CooldownError,
  InvalidInputError,
} from "@kovara/sdk";

async function submitPost(address: string, content: string) {
  try {
    const xdr = client.createPost(address, content);
    // ... sign and submit
  } catch (err) {
    if (err instanceof NotFoundError) return showError("Resource not found.");
    if (err instanceof UnauthorizedError) return showError("Permission denied.");
    if (err instanceof InsufficientBalanceError) return showError("Insufficient balance.");
    if (err instanceof CooldownError) return showError("Cooldown active. Try later.");
    if (err instanceof InvalidInputError) return showError(err.message);
    if (err instanceof KovaraError) return showError("SDK error: " + err.message);
    throw err; // re-throw unexpected non-SDK errors
  }
}
```

---

## How Errors Are Mapped

The SDK's internal `mapError(err)` function converts raw Soroban RPC simulation error strings into typed subclasses using regex matching on the error message. The mapping table is:

| Pattern (case-insensitive)                                    | Mapped to                  |
| ------------------------------------------------------------- | -------------------------- |
| `allowance` / `insufficient allowance`                        | `InsufficientBalanceError` |
| `balance` / `low balance` / `insufficient balance`            | `InsufficientBalanceError` |
| `unauthorized` / `not admin` / `only admin` / `only author`   | `UnauthorizedError`        |
| `blocked`                                                     | `UnauthorizedError`        |
| `not found` / `does not exist`                                | `NotFoundError`            |
| `cooldown`                                                    | `CooldownError`            |
| `invalid` / `too long` / `must be positive` / `cannot exceed` | `InvalidInputError`        |
| _(anything else)_                                             | `KovaraError`              |

You can inspect the `originalError` property on any caught error to access the raw RPC response for debugging.
