# Linkora Social - SDK Usage Examples

This directory contains runnable examples demonstrating how to use the typed Linkora Social SDK client (`LinkoraClient`) in both Node.js (backend/testing) and browser (frontend/wallet) runtimes.

---

## Prerequisites

Before running the examples, ensure that the workspace packages are built:

```bash
# Build the typescript packages (sdk & contract wrappers)
pnpm build
```

---

## 1. Node.js Integration Example (`node-example.ts`)

The Node.js example script showcases how to connect to the Stellar blockchain, fetch on-chain profile metadata, check post metrics, and prepare a write operation signed via a standard `Keypair`.

### Running the Example

Run the script directly using `ts-node` from the repository root:

```bash
npx ts-node -O '{"module": "commonjs"}' examples/sdk/node-example.ts
```

### Core Code Snippet (Node.js)

```typescript
import { LinkoraClient } from "../../packages/sdk/src/index";
import { Keypair } from "@stellar/stellar-sdk";

// Initialize the client pointing to Stellar RPC
const client = new LinkoraClient({
  rpcUrl: "https://soroban-testnet.stellar.org",
  contractId: "CDH4Z2LWYUQCXSQ66ZUP5G6T4I5S2XZS2XST4D4D4D4D4D4D4D4D4D4D",
  networkPassphrase: "Test SDF Network ; September 2015",
});

// Fetch on-chain profiles
const profile = await client.getProfile("GBVVJJWAKJHTEQHZGM5AOKXJLNBGKDSMXZXJZXJZXJZXJZXJZXJZXJ");

// Publish posts using private keys / Keypairs as Signers
const signerKeypair = Keypair.fromSecret("S...");
const result = await client.createPost(
  signerKeypair, // signs built envelope automatically
  signerKeypair.publicKey(),
  {
    author: signerKeypair.publicKey(),
    content: "Publishing directly from a Node.js process!"
  }
);
console.log(`Post created! Tx Hash: ${result.txHash}, Post ID: ${result.postId}`);
```

---

## 2. Browser Integration Example (`browser-example.html`)

The browser example demonstrates how to integrate the SDK in client-side Single Page Applications (SPAs) leveraging the **Freighter Wallet** browser extension for signing transaction envelopes.

### Running the Example

Simply open the HTML file directly in any modern browser that has the [Freighter Wallet](https://www.freighter.app/) extension installed:

```bash
# On macOS
open examples/sdk/browser-example.html
```

### Core Code Snippet (Browser)

```javascript
// Check for Freighter support
if (typeof window.freighter !== "undefined") {
  // Connect and fetch public key
  const publicKey = await window.freighter.getPublicKey();
  
  // Wire up the Linkora client
  const client = new LinkoraClient({
    rpcUrl: "https://soroban-testnet.stellar.org",
    contractId: "CDH4Z2LWYUQCXSQ66ZUP5G6T4I5S2XZS2XST4D4D4D4D4D4D4D4D4D4D",
    networkPassphrase: "Test SDF Network ; September 2015",
  });

  // Call likes / reactions signed with Freighter wallet helper
  const result = await client.likePost(
    window.freighter, // Freighter matches the Signer interface (.signTransaction)
    publicKey,
    {
      user: publicKey,
      postId: 109n,
    }
  );
  console.log(`Liked post! Tx Hash: ${result.txHash}`);
}
```
