import { useMemo, useState } from "react";

import { useWallet } from "./useWallet";
import {
  isValidStellarAddress,
  getPoolAvailableAmount,
  getPoolWithdrawalAmountError,
  normalizeAddress,
  recordPoolWithdrawal,
  usePoolRecord,
} from "../utils/poolStore";

export interface PoolSignerStatus {
  address: string;
  approved: boolean;
}

export interface UsePoolWithdrawReturn {
  pool: ReturnType<typeof usePoolRecord>;
  recipient: string;
  amount: string;
  connectedAddress: string | null;
  connectedIsAdmin: boolean;
  signerStatuses: PoolSignerStatus[];
  approvals: string[];
  canSubmit: boolean;
  recipientError: string | null;
  amountError: string | null;
  availableAmount: string;
  thresholdStatus: string;
  toggleSigner: (address: string) => void;
  setRecipient: (value: string) => void;
  setAmount: (value: string) => void;
  submit: () => Promise<string | null>;
  reset: () => void;
}

export function usePoolWithdraw(poolId: string): UsePoolWithdrawReturn {
  const pool = usePoolRecord(poolId);
  const { address, connected } = useWallet();
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [approvals, setApprovals] = useState<string[]>([]);

  const connectedAddress = address ? normalizeAddress(address) : null;
  const connectedIsAdmin = Boolean(
    connected && connectedAddress && pool.admins.includes(connectedAddress)
  );

  const signerStatuses = useMemo<PoolSignerStatus[]>(
    () =>
      pool.admins.map((admin) => ({
        address: admin,
        approved: approvals.includes(admin),
      })),
    [approvals, pool.admins]
  );

  const recipientError =
    recipient.trim().length === 0
      ? "Recipient is required"
      : isValidStellarAddress(recipient)
      ? null
      : "Enter a valid Stellar address";

  const amountError = getPoolWithdrawalAmountError(poolId, amount);
  const availableAmount = getPoolAvailableAmount(pool);

  const thresholdStatus = `${approvals.length}/${pool.threshold} approvals`;
  const canSubmit =
    Boolean(amount.trim()) &&
    amountError === null &&
    recipientError === null &&
    approvals.length >= pool.threshold;

  const toggleSigner = (address: string) => {
    const signerAddress = normalizeAddress(address);

    if (!pool.admins.includes(signerAddress)) {
      return;
    }

    setApprovals((current) =>
      current.includes(signerAddress)
        ? current.filter((admin) => admin !== signerAddress)
        : [...current, signerAddress]
    );
  };

  const submit = async (): Promise<string | null> => {
    if (!canSubmit) {
      return null;
    }

    const withdrawal = recordPoolWithdrawal(poolId, {
      recipient: normalizeAddress(recipient),
      amount: amount.trim(),
      approvals,
    });

    if (!withdrawal) {
      return null;
    }

    return withdrawal.id;
  };

  const reset = () => {
    setRecipient("");
    setAmount("");
    setApprovals([]);
  };

  return {
    pool,
    recipient,
    amount,
    connectedAddress,
    connectedIsAdmin,
    signerStatuses,
    approvals,
    canSubmit,
    recipientError,
    amountError,
    availableAmount,
    thresholdStatus,
    toggleSigner,
    setRecipient,
    setAmount,
    submit,
    reset,
  };
}
