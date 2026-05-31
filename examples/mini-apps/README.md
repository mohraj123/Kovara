# Linkora Mini Apps — Examples

Mini apps are single-page HTML/JS applications that run inside the Linkora mobile app's built-in browser. They communicate with the host app through the `window.LinkoraSDK` bridge, which exposes wallet signing and post interaction APIs.

---

## Available Examples

| App | Description |
|-----|-------------|
| [`tip-jar/`](./tip-jar/) | Send XLM tips to any Linkora post by ID |

---

## How Mini Apps Work

When a mini app is loaded inside Linkora, the host injects `window.LinkoraSDK` before the page script runs:

```js
window.LinkoraSDK = {
  wallet: {
    /** Returns the connected Stellar public key */
    getAddress: () => Promise<string>,

    /** Signs a transaction XDR and returns the signed envelope */
    signTransaction: (txXdr: string) => Promise<{ signedTxXdr: string }>,
  },
};
```

Mini apps declare their required permissions in `linkora-manifest.json`. The host app prompts the user to grant those permissions before loading the app.

---

## Manifest Format

Every mini app must include a `linkora-manifest.json` at its root:

```json
{
  "name": "My App",
  "version": "1.0.0",
  "description": "Short description shown in the mini app browser.",
  "entry": "index.html",
  "permissions": ["wallet.getAddress", "wallet.signTransaction"],
  "author": "Your Name",
  "minSdkVersion": "1.0.0"
}
```

### Permissions

| Permission | Description |
|------------|-------------|
| `wallet.getAddress` | Read the user's connected Stellar public key |
| `wallet.signTransaction` | Request the user to sign a transaction XDR |

---

## Running Locally

Mini apps are plain HTML files — no build step required.

```bash
# Serve the tip-jar example locally
npx serve examples/mini-apps/tip-jar
# Then open http://localhost:3000
```

When running outside the Linkora app, `window.LinkoraSDK` is not injected. Each example includes a **dev fallback** that mocks the SDK so you can test the UI without a real wallet.

---

## tip-jar

A reference mini app that demonstrates:

- Reading the connected wallet address via `LinkoraSDK.wallet.getAddress()`
- Building a tip transaction for a post by ID
- Requesting a wallet signature via `LinkoraSDK.wallet.signTransaction()`

### Setup

1. Open `tip-jar/index.html` in a browser (or serve it with `npx serve`).
2. Enter a post ID and an XLM amount.
3. Click **Send Tip** — the dev mock will simulate signing and submission.

To use with a real wallet inside the Linkora app, load the mini app via the **Mini Apps** tab and grant the requested permissions.
