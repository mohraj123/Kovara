import { KovaraClient } from "Kovara-sdk";

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

let instance: KovaraClient | null = null;

export function getContractClient(): KovaraClient {
  if (!instance) {
    instance = new KovaraClient({
      contractId: required("NEXT_PUBLIC_CONTRACT_ID"),
      rpcUrl: required("NEXT_PUBLIC_SOROBAN_RPC_URL"),
      networkPassphrase: required("NEXT_PUBLIC_NETWORK_PASSPHRASE"),
    });
  }
  return instance;
}

export async function signAndSubmit(xdr: string): Promise<{ hash: string; ledger: number }> {
  const { TransactionBuilder, rpc } = await import("@stellar/stellar-sdk");

  const signedXdr = await window.freighterApi!.signTransaction(xdr);
  const tx = TransactionBuilder.fromXDR(signedXdr, required("NEXT_PUBLIC_NETWORK_PASSPHRASE"));

  const server = new rpc.Server(required("NEXT_PUBLIC_SOROBAN_RPC_URL"));
  const sendResult = await server.sendTransaction(tx);

  if (sendResult.status === "ERROR") {
    throw new Error(sendResult.errorResult?.result().toString() ?? "Transaction failed");
  }

  let getResult = await server.getTransaction(sendResult.hash);
  while (getResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    await new Promise((r) => setTimeout(r, 1000));
    getResult = await server.getTransaction(sendResult.hash);
  }

  if (getResult.status === rpc.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed on-chain");
  }

  return { hash: sendResult.hash, ledger: getResult.ledger ?? 0 };
}
