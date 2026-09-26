import express from "express";
import request from "supertest";
import { KeyObject, generateKeyPairSync, sign } from "crypto";
import {
  DEFAULT_WALLET_HEADERS,
  InMemoryNonceRegistry,
  SEP53_PREFIX,
  buildSignableMessage,
  decodeStellarAddress,
  encodeStellarAddress,
  verifyWalletSignature,
  walletSignatureMiddleware,
  WalletIdentity,
} from "../wallet-signature";

interface Wallet {
  address: string;
  privateKey: KeyObject;
}

function makeWallet(): Wallet {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return { address: encodeStellarAddress(raw), privateKey };
}

function proof(wallet: Wallet, overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  const timestamp = overrides[DEFAULT_WALLET_HEADERS.timestamp] ?? String(Date.now());
  const nonce = overrides[DEFAULT_WALLET_HEADERS.nonce] ?? `nonce-${Math.random()}`;
  const method = overrides["__method"] ?? "GET";
  const path = overrides["__path"] ?? "/protected";

  const message = buildSignableMessage({ method, path, timestamp, nonce });
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(SEP53_PREFIX), message]),
    wallet.privateKey
  ).toString("base64");

  return {
    [DEFAULT_WALLET_HEADERS.address]: overrides[DEFAULT_WALLET_HEADERS.address] ?? wallet.address,
    [DEFAULT_WALLET_HEADERS.signature]: overrides[DEFAULT_WALLET_HEADERS.signature] ?? signature,
    [DEFAULT_WALLET_HEADERS.timestamp]: timestamp,
    [DEFAULT_WALLET_HEADERS.nonce]: nonce,
  };
}

function makeApp(options: Parameters<typeof walletSignatureMiddleware>[0] = {}) {
  const app = express();
  app.use(express.json());
  app.use(walletSignatureMiddleware(options));
  app.get("/protected", (req, res) => {
    res.json({ wallet: req.wallet });
  });
  return app;
}

describe("Stellar strkey helpers (#670)", () => {
  it("round-trips a raw public key and address", () => {
    const raw = Buffer.alloc(32, 7);
    const address = encodeStellarAddress(raw);
    expect(address).toMatch(/^G[A-Z2-7]{55}$/);
    expect(decodeStellarAddress(address)).toEqual(raw);
  });

  it("rejects addresses with a broken checksum", () => {
    const raw = Buffer.alloc(32, 1);
    const address = encodeStellarAddress(raw);
    // Flip the final character to a different valid base32 character.
    const last = address.slice(-1) === "A" ? "B" : "A";
    expect(decodeStellarAddress(address.slice(0, -1) + last)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(decodeStellarAddress("not-an-address")).toBeNull();
    expect(decodeStellarAddress("")).toBeNull();
  });
});

describe("verifyWalletSignature (#670)", () => {
  it("accepts a signature over the exact message", () => {
    const wallet = makeWallet();
    const message = buildSignableMessage({
      method: "GET",
      path: "/protected",
      timestamp: 1,
      nonce: "n",
    });
    const signature = sign(
      null,
      Buffer.concat([Buffer.from(SEP53_PREFIX), message]),
      wallet.privateKey
    ).toString("base64");

    expect(
      verifyWalletSignature({ address: wallet.address, message, signature })
    ).toBe(true);
  });

  it("rejects a signature over different bytes", () => {
    const wallet = makeWallet();
    const message = buildSignableMessage({
      method: "GET",
      path: "/protected",
      timestamp: 1,
      nonce: "n",
    });
    const signature = sign(
      null,
      Buffer.concat([Buffer.from(SEP53_PREFIX), Buffer.from("different")]),
      wallet.privateKey
    ).toString("base64");

    expect(verifyWalletSignature({ address: wallet.address, message, signature })).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const wallet = makeWallet();
    const other = makeWallet();
    const message = buildSignableMessage({
      method: "GET",
      path: "/protected",
      timestamp: 1,
      nonce: "n",
    });
    const signature = sign(
      null,
      Buffer.concat([Buffer.from(SEP53_PREFIX), message]),
      other.privateKey
    ).toString("base64");

    expect(verifyWalletSignature({ address: wallet.address, message, signature })).toBe(false);
  });
});

describe("walletSignatureMiddleware (#670)", () => {
  it("accepts a valid proof and attaches the verified address", async () => {
    const wallet = makeWallet();
    const res = await request(makeApp({ store: undefined })).get("/protected").set(proof(wallet));

    expect(res.status).toBe(200);
    expect(res.body.wallet.address).toBe(wallet.address);
    expect(res.body.wallet.identity).toBeNull();
  });

  it("maps a verified address to a user identity", async () => {
    const wallet = makeWallet();
    const identity: WalletIdentity = { id: "user-1", address: wallet.address, username: "alice" };
    const store = { resolveByAddress: jest.fn(async () => identity) };

    const res = await request(makeApp({ store })).get("/protected").set(proof(wallet));

    expect(res.status).toBe(200);
    expect(res.body.wallet.identity).toEqual(identity);
    expect(store.resolveByAddress).toHaveBeenCalledWith(wallet.address);
  });

  it("rejects a request with no proof by default", async () => {
    const res = await request(makeApp()).get("/protected");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "WALLET_PROOF_REQUIRED" });
  });

  it("passes an anonymous request through when not required", async () => {
    const res = await request(makeApp({ required: false })).get("/protected");
    expect(res.status).toBe(200);
    expect(res.body.wallet).toBeUndefined();
  });

  it("rejects an invalid signature", async () => {
    const wallet = makeWallet();
    const res = await request(makeApp())
      .get("/protected")
      .set(proof(wallet, { [DEFAULT_WALLET_HEADERS.signature]: Buffer.alloc(64, 1).toString("base64") }));

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "WALLET_SIGNATURE_INVALID" });
  });

  it("rejects an expired proof", async () => {
    const wallet = makeWallet();
    const old = String(Date.now() - 10 * 60 * 1000);
    const res = await request(makeApp()).get("/protected").set(proof(wallet, { [DEFAULT_WALLET_HEADERS.timestamp]: old }));

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "WALLET_PROOF_EXPIRED" });
  });

  it("rejects a proof signed for a different path", async () => {
    const wallet = makeWallet();
    // Build a proof whose signed path is "/other" but send it to "/protected".
    const timestamp = String(Date.now());
    const nonce = "n-different-path";
    const message = buildSignableMessage({ method: "GET", path: "/other", timestamp, nonce });
    const signature = sign(
      null,
      Buffer.concat([Buffer.from(SEP53_PREFIX), message]),
      wallet.privateKey
    ).toString("base64");

    const res = await request(makeApp())
      .get("/protected")
      .set({
        [DEFAULT_WALLET_HEADERS.address]: wallet.address,
        [DEFAULT_WALLET_HEADERS.signature]: signature,
        [DEFAULT_WALLET_HEADERS.timestamp]: timestamp,
        [DEFAULT_WALLET_HEADERS.nonce]: nonce,
      });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "WALLET_SIGNATURE_INVALID" });
  });

  it("rejects a reused nonce", async () => {
    const wallet = makeWallet();
    const nonces = new InMemoryNonceRegistry();
    const app = makeApp({ nonces });
    const headers = proof(wallet, { [DEFAULT_WALLET_HEADERS.nonce]: "fixed-nonce" });

    const first = await request(app).get("/protected").set(headers);
    const second = await request(app).get("/protected").set(headers);

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    expect(second.body).toMatchObject({ code: "WALLET_NONCE_REUSED" });
  });

  it("rejects a malformed address with a distinct code", async () => {
    const wallet = makeWallet();
    const res = await request(makeApp())
      .get("/protected")
      .set(proof(wallet, { [DEFAULT_WALLET_HEADERS.address]: "G-not-real" }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "WALLET_ADDRESS_INVALID" });
  });
});
