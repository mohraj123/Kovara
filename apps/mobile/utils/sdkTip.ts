import { KovaraClient } from "../../../packages/sdk/src/client";
import type { WalletKitAdapter } from "../types/walletContext.types";

export interface TipResult {
  txHash: string;
  amount: bigint;
}

/**
 * Submits a tip transaction to the contract via the SDK and wallet.
 *
 * @param contractId - The contract ID to call
 * @param rpcUrl - The Soroban RPC URL
 * @param sender - The sender's wallet address
 * @param postId - The post ID to tip
 * @param amount - The tip amount in stroops (smallest unit)
 * @param walletKit - The wallet adapter for signing transactions
 * @returns The transaction hash and tip amount
 */
export async function sdkTip(
  contractId: string,
  rpcUrl: string,
  sender: string,
  postId: number,
  amount: bigint,
  walletKit: WalletKitAdapter
): Promise<TipResult> {
  const client = new KovaraClient({ contractId, rpcUrl });
  const txXdr = client.tip(sender, postId, amount);

  let txHash: string;

  if (typeof walletKit.signAndSubmitTransaction === "function") {
    const res = await walletKit.signAndSubmitTransaction({ txXdr, rpcUrl });
    txHash = res.hash ?? res.txHash ?? "";
  } else {
    const signed = await walletKit.signTransaction({ txXdr });
    const { rpc } = await import("@stellar/stellar-sdk");
    const server = new rpc.Server(rpcUrl);
    const res = await server.submitTransaction(signed.signedTxXdr);
    txHash = res?.hash ?? "";
  }

  return { txHash, amount };
}
