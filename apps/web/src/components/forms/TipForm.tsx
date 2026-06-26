"use client";

/**
 * packages/web/src/components/forms/TipForm.tsx
 *
 * Tip submission form with robust validation and Soroban contract error
 * handling.
 *
 * Issue #117 – validate amount, token, and recipient before submission;
 * surface contract / network errors clearly to the user.
 */

import { useState } from "react";
import { FLOW_REWARDS_CONTRACT_ID, STELLAR_NETWORK } from "../../../config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SupportedToken = "XLM" | "USDC";

export interface TipFormProps {
  /** Pre-fill the recipient address (e.g. from the pool entry row) */
  defaultRecipient?: string;
  /** Called after a confirmed on-chain submission */
  onSuccess?: (txHash: string) => void;
}

interface FormState {
  recipient: string;
  amount: string;
  token: SupportedToken | "";
}

interface FormErrors {
  recipient?: string;
  amount?: string;
  token?: string;
  submit?: string;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const MIN_TIP_XLM = 0.01;
const MAX_TIP_XLM = 10_000;
const MIN_TIP_USDC = 0.01;
const MAX_TIP_USDC = 10_000;

function validateForm(state: FormState): FormErrors {
  const errors: FormErrors = {};

  // Recipient
  if (!state.recipient.trim()) {
    errors.recipient = "Recipient address is required.";
  } else if (!STELLAR_ADDRESS_RE.test(state.recipient.trim())) {
    errors.recipient =
      "Must be a valid Stellar public key starting with G (56 characters).";
  }

  // Token
  if (!state.token) {
    errors.token = "Please select a token (XLM or USDC).";
  }

  // Amount
  const raw = state.amount.trim();
  if (!raw) {
    errors.amount = "Amount is required.";
  } else {
    const parsed = parseFloat(raw);
    if (isNaN(parsed) || parsed <= 0) {
      errors.amount = "Amount must be a positive number.";
    } else if (!Number.isFinite(parsed)) {
      errors.amount = "Amount is not a valid number.";
    } else if (state.token === "XLM") {
      if (parsed < MIN_TIP_XLM) {
        errors.amount = `Minimum tip is ${MIN_TIP_XLM} XLM.`;
      } else if (parsed > MAX_TIP_XLM) {
        errors.amount = `Maximum tip is ${MAX_TIP_XLM.toLocaleString()} XLM.`;
      }
    } else if (state.token === "USDC") {
      if (parsed < MIN_TIP_USDC) {
        errors.amount = `Minimum tip is $${MIN_TIP_USDC} USDC.`;
      } else if (parsed > MAX_TIP_USDC) {
        errors.amount = `Maximum tip is $${MAX_TIP_USDC.toLocaleString()} USDC.`;
      }
    }

    // Guard against more than 7 decimal places (Stellar precision)
    const decimalPart = raw.split(".")[1];
    if (decimalPart && decimalPart.length > 7) {
      errors.amount = "Stellar supports a maximum of 7 decimal places.";
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Contract submission (stub – replace with real Soroban SDK call)
// ---------------------------------------------------------------------------

async function submitTipToContract(params: {
  recipient: string;
  amount: number;
  token: SupportedToken;
  contractId: string;
  network: string;
}): Promise<{ txHash: string }> {
  /**
   * TODO: Replace this stub with the actual @stellar/stellar-sdk / soroban-client
   * invocation:
   *
   *   const server = new SorobanRpc.Server(SOROBAN_RPC_URL);
   *   const contract = new Contract(params.contractId);
   *   const tx = new TransactionBuilder(sourceAccount, { fee, networkPassphrase })
   *     .addOperation(contract.call("tip", ..., xdr.ScVal...))
   *     .setTimeout(30)
   *     .build();
   *   const prepared = await server.prepareTransaction(tx);
   *   const signed   = await freighter.signTransaction(prepared.toXDR(), { network });
   *   const result   = await server.sendTransaction(signed);
   *   return { txHash: result.hash };
   */
  console.log("[TipForm] Submitting tip:", params);
  // Simulate network latency in development
  await new Promise((r) => setTimeout(r, 1200));
  // Simulate random contract errors for testing
  if (Math.random() < 0.15) {
    throw new SorobanContractError("CONTRACT_INSUFFICIENT_FUNDS", {
      code: "CONTRACT_INSUFFICIENT_FUNDS",
      message: "The FlowRewards pool has insufficient funds for this tip.",
    });
  }
  return { txHash: "SIMULATED_TX_HASH_" + Date.now() };
}

// ---------------------------------------------------------------------------
// Custom error class for contract-level failures
// ---------------------------------------------------------------------------

class SorobanContractError extends Error {
  readonly code: string;
  constructor(code: string, details: { code: string; message: string }) {
    super(details.message);
    this.name = "SorobanContractError";
    this.code = code;
  }
}

/** Maps known contract error codes to user-friendly messages */
function humaniseContractError(err: unknown): string {
  if (err instanceof SorobanContractError) {
    const friendlyMessages: Record<string, string> = {
      CONTRACT_INSUFFICIENT_FUNDS:
        "The tip pool doesn't have enough funds right now. Please try again later.",
      CONTRACT_RECIPIENT_NOT_FOUND:
        "Recipient account not found on the Stellar network. They may need to activate their account first.",
      CONTRACT_SELF_TIP_NOT_ALLOWED: "You cannot tip your own account.",
      CONTRACT_AMOUNT_TOO_LOW:
        "The tip amount is below the contract minimum. Please increase it.",
      CONTRACT_PAUSED:
        "The Kovara tip contract is temporarily paused. Check discord for updates.",
    };
    return (
      friendlyMessages[err.code] ??
      `Contract error (${err.code}): ${err.message}`
    );
  }

  if (err instanceof TypeError && err.message.includes("fetch")) {
    return "Network error – could not reach the Stellar RPC. Check your connection and try again.";
  }

  if (err instanceof Error) {
    // Horizon / Soroban SDK often embeds the result code in the message
    if (err.message.includes("tx_insufficient_balance")) {
      return "Your wallet balance is too low to cover this tip and the transaction fee.";
    }
    if (err.message.includes("op_underfunded")) {
      return "Your account is underfunded. Please add XLM to cover the operation.";
    }
    return err.message;
  }

  return "An unexpected error occurred. Please try again.";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TipForm({ defaultRecipient = "", onSuccess }: TipFormProps) {
  const [form, setForm] = useState<FormState>({
    recipient: defaultRecipient,
    amount: "",
    token: "",
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
    // Clear the field error on change
    if (errors[name as keyof FormErrors]) {
      setErrors((prev) => ({ ...prev, [name]: undefined }));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setTxHash(null);

    // --- Client-side validation ---
    const validationErrors = validateForm(form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setSubmitting(true);
    try {
      const result = await submitTipToContract({
        recipient: form.recipient.trim(),
        amount: parseFloat(form.amount),
        token: form.token as SupportedToken,
        contractId: FLOW_REWARDS_CONTRACT_ID,
        network: STELLAR_NETWORK,
      });

      setTxHash(result.txHash);
      setForm({ recipient: defaultRecipient, amount: "", token: "" });
      onSuccess?.(result.txHash);
    } catch (err) {
      setErrors({ submit: humaniseContractError(err) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="space-y-5 rounded-xl border bg-white p-6 shadow-sm dark:bg-gray-900"
      aria-label="Send a tip"
    >
      <h2 className="text-lg font-semibold">Send a Tip</h2>

      {/* ---- Recipient ---- */}
      <div>
        <label
          htmlFor="tip-recipient"
          className="mb-1 block text-sm font-medium"
        >
          Recipient address
        </label>
        <input
          id="tip-recipient"
          name="recipient"
          type="text"
          value={form.recipient}
          onChange={handleChange}
          placeholder="GABC…"
          aria-describedby={errors.recipient ? "recipient-error" : undefined}
          className={`w-full rounded-md border px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 ${
            errors.recipient
              ? "border-red-400 focus:ring-red-300"
              : "border-gray-300 focus:ring-blue-300 dark:border-gray-600"
          }`}
        />
        {errors.recipient && (
          <p id="recipient-error" className="mt-1 text-xs text-red-600">
            {errors.recipient}
          </p>
        )}
      </div>

      {/* ---- Token ---- */}
      <div>
        <label htmlFor="tip-token" className="mb-1 block text-sm font-medium">
          Token
        </label>
        <select
          id="tip-token"
          name="token"
          value={form.token}
          onChange={handleChange}
          aria-describedby={errors.token ? "token-error" : undefined}
          className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 ${
            errors.token
              ? "border-red-400 focus:ring-red-300"
              : "border-gray-300 focus:ring-blue-300 dark:border-gray-600"
          }`}
        >
          <option value="">Select token…</option>
          <option value="XLM">XLM (Lumen)</option>
          <option value="USDC">USDC (Stellar)</option>
        </select>
        {errors.token && (
          <p id="token-error" className="mt-1 text-xs text-red-600">
            {errors.token}
          </p>
        )}
      </div>

      {/* ---- Amount ---- */}
      <div>
        <label htmlFor="tip-amount" className="mb-1 block text-sm font-medium">
          Amount{" "}
          {form.token && (
            <span className="text-muted-foreground font-normal">
              ({form.token})
            </span>
          )}
        </label>
        <input
          id="tip-amount"
          name="amount"
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={form.amount}
          onChange={handleChange}
          placeholder="0.05"
          aria-describedby={errors.amount ? "amount-error" : undefined}
          className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 ${
            errors.amount
              ? "border-red-400 focus:ring-red-300"
              : "border-gray-300 focus:ring-blue-300 dark:border-gray-600"
          }`}
        />
        {errors.amount && (
          <p id="amount-error" className="mt-1 text-xs text-red-600">
            {errors.amount}
          </p>
        )}
      </div>

      {/* ---- Submit error ---- */}
      {errors.submit && (
        <div
          role="alert"
          className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400"
        >
          <strong>Submission failed:</strong> {errors.submit}
        </div>
      )}

      {/* ---- Success ---- */}
      {txHash && (
        <div
          role="status"
          className="rounded-md bg-green-50 px-4 py-3 text-sm text-green-700 dark:bg-green-900/20 dark:text-green-400"
        >
          <strong>Tip sent!</strong> Transaction:{" "}
          <code className="break-all">{txHash}</code>
        </div>
      )}

      {/* ---- Submit button ---- */}
      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? "Submitting…" : "Send Tip"}
      </button>
    </form>
  );
}