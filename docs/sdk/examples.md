# KovaraClient Usage Examples

Practical, typed examples for the most common SDK operations: creating posts, sending tips, and liking posts.

All write methods return a **base64-encoded XDR envelope** you sign and submit via your wallet or keypair. Read methods return fully-typed objects directly.

---

## Setup

```ts
import { KovaraClient } from "@kovara/sdk";

const client = new KovaraClient({
  contractId: "CDLDVFKHEZ2RVB3NG4UQA4VPD3TSHV6XMHXMHP2BSGCJ2IIWVTOHGDSG",
  rpcUrl: "https://soroban-testnet.stellar.org",
  // defaults to Testnet passphrase; set for Mainnet:
  // networkPassphrase: "Public Global Stellar Network ; September 2015",
});
```

---

## Post Creation

### Build and submit a post

`createPost` returns an XDR string. Sign it with your keypair or wallet, then submit to Stellar.

```ts
import { KovaraClient } from "@kovara/sdk";
import { Keypair, rpc, TransactionBuilder } from "@stellar/stellar-sdk";

const client = new KovaraClient({
  contractId: "C...",
  rpcUrl: "https://soroban-testnet.stellar.org",
});
const keypair = Keypair.fromSecret("S...");
const server = new rpc.Server("https://soroban-testnet.stellar.org");

// 1. Build the unsigned XDR envelope
const xdrEnvelope: string = client.createPost(
  keypair.publicKey(), // author address
  "Hello Kovara! 🌍" // post content (max 500 chars)
);

// 2. Sign
const tx = TransactionBuilder.fromXDR(xdrEnvelope, "Test SDF Network ; September 2015");
tx.sign(keypair);

// 3. Submit
const result = await server.sendTransaction(tx);
console.log("Post submitted. Hash:", result.hash);
```

### Read back the post

```ts
import { Post } from "@kovara/sdk";

const post: Post | null = await client.getPost(1);
if (post) {
  console.log(`@${post.username}: ${post.content}`);
  console.log(`Likes: ${post.like_count}  Tips: ${post.tip_total}`);
}
```

**`Post` type:**

```ts
interface Post {
  id: number;
  author: string; // Stellar address
  username: string;
  content: string;
  tip_total: number;
  timestamp: number; // Unix seconds
  like_count: number;
}
```

---

## Tips

### Send a tip

Tips are denominated in the contract's native stroops (1 XLM = 10,000,000 stroops). `amount` accepts `number | bigint`.

```ts
const TIP_AMOUNT = 5_000_000n; // 0.5 XLM in stroops

const xdrEnvelope: string = client.tip(
  keypair.publicKey(), // sender address
  42, // postId
  TIP_AMOUNT
);

const tx = TransactionBuilder.fromXDR(xdrEnvelope, "Test SDF Network ; September 2015");
tx.sign(keypair);
const result = await server.sendTransaction(tx);
console.log("Tip sent. Hash:", result.hash);
```

> **Cooldown:** The contract enforces a per-sender cooldown between tips to the same post. If you tip before the window expires, the SDK throws `CooldownError`. See [Error Handling](./error-handling.md).

### Check tip total on a post

```ts
const post = await client.getPost(42);
console.log("Total tips received:", post?.tip_total);
```

---

## Likes

### Like a post

```ts
const xdrEnvelope: string = client.like(
  keypair.publicKey(), // liker address
  42 // postId
);

const tx = TransactionBuilder.fromXDR(xdrEnvelope, "Test SDF Network ; September 2015");
tx.sign(keypair);
await server.sendTransaction(tx);
```

### Unlike a post

```ts
const xdrEnvelope: string = client.unlike(keypair.publicKey(), 42);
const tx = TransactionBuilder.fromXDR(xdrEnvelope, "Test SDF Network ; September 2015");
tx.sign(keypair);
await server.sendTransaction(tx);
```

### Check whether an address has liked a post

```ts
const liked: boolean = await client.hasLiked(keypair.publicKey(), 42);
console.log("Has liked:", liked);
```

### Get total like count

```ts
const count: number = await client.getLikeCount(42);
console.log("Like count:", count);
```

---

## Browser / Freighter Wallet

In a browser context replace `Keypair.sign` with Freighter's `signTransaction`:

```ts
import freighterApi from "@stellar/freighter-api";

const publicKey = await freighterApi.getPublicKey();
const xdrEnvelope = client.createPost(publicKey, "Posted from the browser!");

const signedXdr = await freighterApi.signTransaction(xdrEnvelope, {
  networkPassphrase: "Test SDF Network ; September 2015",
});

const tx = TransactionBuilder.fromXDR(signedXdr, "Test SDF Network ; September 2015");
await server.sendTransaction(tx);
```

---

## Tips & Best Practices

- **Validate content length** before calling `createPost`. The contract rejects content longer than 500 characters and throws `InvalidInputError`.
- **Use `bigint` for amounts** to avoid floating-point precision issues with large stroop values.
- **Simulate first** with `server.simulateTransaction(tx)` to catch errors and estimate fees before submitting.
- **Handle errors by type** — import `NotFoundError`, `CooldownError`, etc. from `@kovara/sdk`. See [Error Handling](./error-handling.md) for the full classification.
