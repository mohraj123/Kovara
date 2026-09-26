/**
 * Wallet-based signature verification middleware (#670).
 *
 * A Stellar address is public, so `x-stellar-address: G…` proves nothing: any
 * caller can claim any address. The only thing that proves control of an
 * address is a signature by its private key, so this middleware requires one
 * for the routes it guards and rejects anything it cannot verify.
 *
 * Three acceptance criteria shape it:
 *
 *   1. **Verify wallet signatures and reject invalid ones.** Verification is
 *      the real ed25519 check over the exact bytes the wallet signed. A decode
 *      failure, an invalid address, a malformed signature, or a signature over
 *      different bytes are all a rejection.
 *   2. **Map verified public keys to user identities.** A verified address is
 *      handed to a {@link WalletIdentityStore}, and the resolved identity is
 *      attached to the request alongside the address. The middleware never
 *      invents an identity: an address with no record resolves to `null`.
 *   3. **Failure modes are clear and consistent.** Every rejection is the same
 *      `{ error, code }` JSON shape used across the API, with a distinct code
 *      per cause, so a client can tell "you did not sign" from "your signature
 *      was wrong" from "your proof expired".
 *
 * Signing is deliberately over a **canonical message** built from the request,
 * not the raw body: the client and server both derive it with
 * {@link buildSignableMessage}, so a signature cannot be lifted from one
 * request and replayed against another method or path. A timestamp window and,
 * optionally, a nonce registry bound replay further.
 *
 * Stellar's strkey encoding (base32 + CRC16-XModem) and ed25519 verification
 * are implemented here with Node's `crypto`, so the middleware adds no runtime
 * dependency to the indexer.
 */

import { Request, Response, NextFunction, RequestHandler } from "express";
import { createPublicKey, verify as cryptoVerify } from "crypto";

// ── Stellar strkey (account id) encoding ─────────────────────────────────

/** Strkey version byte for an ed25519 public key ("G…"). */
const ACCOUNT_ID_VERSION = 0x30;

/** RFC 4648 base32 alphabet, as Stellar uses it (upper-case, no padding). */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * The fixed ASN.1 DER prefix for an ed25519 `SubjectPublicKeyInfo`. Node's
 * `crypto` verifies against a `KeyObject`, so a raw 32-byte key is wrapped in
 * this prefix to build one.
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Compute the CRC16-XModem checksum Stellar appends to a strkey. */
function crc16Xmodem(bytes: Buffer): number {
  let crc = 0x0000;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Buffer | null {
  const clean = input.toUpperCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Encode a raw 32-byte ed25519 public key as a Stellar `G…` strkey.
 *
 * Exported because it is the exact inverse of {@link decodeStellarAddress} and
 * lets tests (and tooling) construct a wallet address from a keypair without a
 * second base32 implementation.
 */
export function encodeStellarAddress(publicKey: Buffer): string {
  if (publicKey.length !== 32) {
    throw new Error(`ed25519 public key must be 32 bytes, got ${publicKey.length}`);
  }
  const payload = Buffer.concat([Buffer.from([ACCOUNT_ID_VERSION]), publicKey]);
  const crc = crc16Xmodem(payload);
  const checksum = Buffer.from([crc & 0xff, (crc >> 8) & 0xff]);
  return base32Encode(Buffer.concat([payload, checksum]));
}

/**
 * Decode a Stellar `G…` address to its raw ed25519 public key.
 *
 * Returns `null` for anything that is not a valid account strkey: wrong
 * alphabet, wrong length, wrong version byte, or a checksum mismatch. Checking
 * the checksum is what stops a typo'd address from being treated as a different
 * valid one.
 */
export function decodeStellarAddress(address: string): Buffer | null {
  if (typeof address !== "string") return null;
  const decoded = base32Decode(address);
  if (!decoded || decoded.length !== 35) return null;
  if (decoded[0] !== ACCOUNT_ID_VERSION) return null;

  const payload = decoded.subarray(0, 33);
  const expected = decoded[33] | (decoded[34] << 8);
  if (crc16Xmodem(payload) !== expected) return null;

  return Buffer.from(payload.subarray(1));
}

// ── Signature verification ───────────────────────────────────────────────

/** SEP-53's message prefix, prepended by standard Stellar wallets. */
export const SEP53_PREFIX = "Stellar Signed Message:\n";

/**
 * Verify an ed25519 signature over `message` against a Stellar address.
 *
 * If `sep53` is true the message is prefixed with {@link SEP53_PREFIX} first,
 * matching what a wallet's `signMessage` produces.
 */
export function verifyWalletSignature(params: {
  address: string;
  message: Buffer | string;
  signature: Buffer | string;
  /**
   * Whether to verify against the SEP-53 prefixed message. Defaults to `true`,
   * matching the standard Stellar wallet behaviour and the middleware's own
   * default; pass `false` for a signature over the bare message.
   */
  sep53?: boolean;
}): boolean {
  const sep53 = params.sep53 ?? true;
  const publicKey = decodeStellarAddress(params.address);
  if (!publicKey) return false;

  let signature: Buffer;
  try {
    signature =
      typeof params.signature === "string"
        ? Buffer.from(params.signature, "base64")
        : params.signature;
  } catch {
    return false;
  }
  // ed25519 signatures are exactly 64 bytes; `crypto.verify` would reject a
  // different length anyway, but an explicit check gives a clearer failure.
  if (signature.length !== 64) return false;

  const message =
    typeof params.message === "string" ? Buffer.from(params.message, "utf8") : params.message;
  const signable = sep53
    ? Buffer.concat([Buffer.from(SEP53_PREFIX, "utf8"), message])
    : message;

  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(null, signable, key, signature);
  } catch {
    return false;
  }
}

/**
 * The canonical bytes a client signs for a request.
 *
 * Fixed field order and one field per line, so two different requests cannot
 * produce the same message by concatenation: the method and path are bound in,
 * which stops a signature for a harmless `GET` being replayed against a state
 * changing `POST`.
 */
export function buildSignableMessage(parts: {
  method: string;
  path: string;
  timestamp: number | string;
  nonce: string;
  bodyHash?: string;
}): Buffer {
  const lines = [
    parts.method.toUpperCase(),
    parts.path,
    String(parts.timestamp),
    parts.nonce,
  ];
  if (parts.bodyHash) lines.push(parts.bodyHash);
  return Buffer.from(lines.join("\n"), "utf8");
}

// ── Identity mapping ─────────────────────────────────────────────────────

/** A user identity resolved from a verified wallet address. */
export interface WalletIdentity {
  /** Stable internal user id. */
  id: string;
  address: string;
  username?: string;
}

/**
 * Maps a verified public key to a user identity. Implementations own the
 * lookup; the middleware only calls it after the signature has been verified.
 */
export interface WalletIdentityStore {
  resolveByAddress(address: string): Promise<WalletIdentity | null>;
}

/** The verified wallet context attached to a request. */
export interface WalletContext {
  address: string;
  identity: WalletIdentity | null;
  /** Unix ms at which the proof was verified. */
  verifiedAt: number;
}

// Express request augmentation.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      wallet?: WalletContext;
    }
  }
}

/** The header names the middleware reads. Overridable for custom clients. */
export interface WalletHeaderNames {
  address: string;
  signature: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
}

export const DEFAULT_WALLET_HEADERS: WalletHeaderNames = {
  address: "x-wallet-address",
  signature: "x-wallet-signature",
  timestamp: "x-wallet-timestamp",
  nonce: "x-wallet-nonce",
  bodyHash: "x-wallet-body-hash",
};

/** Reject a proof older or newer than this, in ms. Default: 5 minutes. */
export const DEFAULT_PROOF_WINDOW_MS = 5 * 60 * 1000;

/** Tracks consumed nonces so a captured proof cannot be replayed. */
export interface NonceRegistry {
  /** True when the nonce was already used within its validity window. */
  has(nonce: string): Promise<boolean>;
  /** Record a nonce as used, expiring it at `expiresAtMs`. */
  add(nonce: string, expiresAtMs: number): Promise<void>;
}

export interface WalletSignatureOptions {
  /**
   * Reject requests with no proof. Default `true`: the middleware exists to
   * guard routes, so refusing anonymous callers is the safe default.
   */
  required?: boolean;
  /** Maps verified addresses to identities. Omitted means identity is `null`. */
  store?: WalletIdentityStore;
  /** Nonce registry for replay protection. */
  nonces?: NonceRegistry;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Validity window for a proof, in ms. Default {@link DEFAULT_PROOF_WINDOW_MS}. */
  windowMs?: number;
  /** Set when wallets sign with the SEP-53 prefix. Default `true`. */
  sep53?: boolean;
  headers?: Partial<WalletHeaderNames>;
  /**
   * Called with a verified wallet context. Lets a deployment map the address to
   * a local user record as part of the same middleware chain.
   */
  onVerified?: (wallet: WalletContext, req: Request) => void | Promise<void>;
}

interface WalletFailure {
  status: number;
  code: string;
  error: string;
}

function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/**
 * Build the middleware.
 *
 * The verification order is deliberate: cheap shape checks first (headers
 * present, timestamp fresh, address well-formed), then the signature check,
 * then the identity lookup. A missing proof is rejected before any
 * cryptographic work, so a flood of unsigned requests cannot make the process
 * do ed25519 verification for nothing.
 */
export function walletSignatureMiddleware(
  options: WalletSignatureOptions = {}
): RequestHandler {
  const {
    required = true,
    store,
    nonces,
    now = () => Date.now(),
    windowMs = DEFAULT_PROOF_WINDOW_MS,
    sep53 = true,
    onVerified,
  } = options;

  const headers: WalletHeaderNames = { ...DEFAULT_WALLET_HEADERS, ...options.headers };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const address = headerValue(req, headers.address);
    const signature = headerValue(req, headers.signature);
    const timestamp = headerValue(req, headers.timestamp);
    const nonce = headerValue(req, headers.nonce);
    const bodyHash = headerValue(req, headers.bodyHash);

    // No proof offered at all.
    if (!address || !signature || !timestamp || !nonce) {
      if (!required) {
        next();
        return;
      }
      reject(res, {
        status: 401,
        code: "WALLET_PROOF_REQUIRED",
        error: "A signed wallet proof is required for this endpoint",
      });
      return;
    }

    const issuedAt = Number(timestamp);
    if (!Number.isFinite(issuedAt)) {
      reject(res, {
        status: 400,
        code: "WALLET_TIMESTAMP_INVALID",
        error: "x-wallet-timestamp must be a Unix millisecond timestamp",
      });
      return;
    }

    // Both directions are checked: a proof from the far future is as invalid as
    // an expired one, and accepting it would let a client mint a long-lived
    // proof by simply sending a later timestamp.
    if (Math.abs(now() - issuedAt) > windowMs) {
      reject(res, {
        status: 401,
        code: "WALLET_PROOF_EXPIRED",
        error: `Wallet proof is outside the ${Math.round(windowMs / 1000)}s validity window`,
      });
      return;
    }

    const decoded = decodeStellarAddress(address);
    if (!decoded) {
      reject(res, {
        status: 400,
        code: "WALLET_ADDRESS_INVALID",
        error: "x-wallet-address is not a valid Stellar account address",
      });
      return;
    }

    // Normalize the address to the canonical upper-case strkey so the identity
    // lookup and any logging see one spelling.
    const normalizedAddress = address.toUpperCase();

    const message = buildSignableMessage({
      method: req.method,
      path: req.path,
      timestamp,
      nonce,
      ...(bodyHash ? { bodyHash } : {}),
    });

    if (!verifyWalletSignature({ address: normalizedAddress, message, signature, sep53 })) {
      reject(res, {
        status: 401,
        code: "WALLET_SIGNATURE_INVALID",
        error: "Wallet signature does not match the request or address",
      });
      return;
    }

    if (nonces) {
      try {
        if (await nonces.has(nonce)) {
          reject(res, {
            status: 401,
            code: "WALLET_NONCE_REUSED",
            error: "Wallet proof nonce has already been used",
          });
          return;
        }
        await nonces.add(nonce, issuedAt + windowMs);
      } catch {
        // A failing nonce store must fail closed: without replay tracking the
        // window alone is not enough to distinguish a replay from a retry.
        reject(res, {
          status: 503,
          code: "WALLET_PROOF_UNAVAILABLE",
          error: "Unable to record wallet proof; try again",
        });
        return;
      }
    }

    let identity: WalletIdentity | null = null;
    if (store) {
      try {
        identity = await store.resolveByAddress(normalizedAddress);
      } catch {
        // Identity lookup failure is not a signature failure: the address is
        // verified, so refuse rather than attach a wrong or missing identity.
        reject(res, {
          status: 503,
          code: "WALLET_PROOF_UNAVAILABLE",
          error: "Unable to resolve wallet identity; try again",
        });
        return;
      }
    }

    const wallet: WalletContext = {
      address: normalizedAddress,
      identity,
      verifiedAt: now(),
    };
    req.wallet = wallet;

    if (onVerified) {
      try {
        await onVerified(wallet, req);
      } catch {
        reject(res, {
          status: 503,
          code: "WALLET_PROOF_UNAVAILABLE",
          error: "Unable to complete wallet verification; try again",
        });
        return;
      }
    }

    next();
  };
}

function reject(res: Response, failure: WalletFailure): void {
  res.status(failure.status).json({ error: failure.error, code: failure.code });
}

/**
 * A simple in-memory nonce registry, useful for a single replica and in tests.
 * Multi-replica deployments should back this with shared storage.
 */
export class InMemoryNonceRegistry implements NonceRegistry {
  private readonly used = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async has(nonce: string): Promise<boolean> {
    const expiresAt = this.used.get(nonce);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.used.delete(nonce);
      return false;
    }
    return true;
  }

  async add(nonce: string, expiresAtMs: number): Promise<void> {
    this.used.set(nonce, expiresAtMs);
    // Opportunistically drop expired entries so the map cannot grow without
    // bound under a stream of unique nonces.
    for (const [key, expires] of this.used) {
      if (expires <= this.now()) this.used.delete(key);
    }
  }
}
