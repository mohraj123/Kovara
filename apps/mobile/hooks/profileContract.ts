import { KovaraClient } from "../../../packages/sdk/src/client";

type WalletKitLike = {
  signAndSubmitTransaction?: (opts: { txXdr: string; rpcUrl?: string }) => Promise<{ hash?: string; txHash?: string }>;
  signTransaction?: (opts: { txXdr: string }) => Promise<{ signedTxXdr?: string; signedXdr?: string; signedTx?: string }>;
};

export async function submitProfileTransaction(
  user: string,
  username: string,
  creatorToken: string,
  rpcUrl: string,
  contractId: string
): Promise<string> {
  const client = new KovaraClient({ contractId, rpcUrl });
  const xdrEnv = client.setProfile(user, username, creatorToken);

  const kit = (
    globalThis as unknown as {
      __Kovara_WALLET_KIT__?: WalletKitLike;
    }
  ).__Kovara_WALLET_KIT__;

  if (kit?.signAndSubmitTransaction) {
    const res = await kit.signAndSubmitTransaction({ txXdr: xdrEnv, rpcUrl });
    const txHash = res?.hash ?? res?.txHash;
    if (!txHash) throw new Error("Transaction not confirmed");
    return txHash;
  }

  if (kit?.signTransaction) {
    const signed = await kit.signTransaction({ txXdr: xdrEnv });
    const signedXdr = signed?.signedTxXdr ?? signed?.signedXdr ?? signed?.signedTx;
    if (!signedXdr) throw new Error("Wallet did not return signed transaction XDR");

    const { rpc } = await import("@stellar/stellar-sdk");
    const server = new rpc.Server(rpcUrl);
    const submitRes = await server.submitTransaction(signedXdr);
    const txHash = submitRes?.hash ?? "";
    if (!txHash) throw new Error("Transaction not confirmed");
    return txHash;
  }

  throw new Error("Wallet signing not available in this environment");
}
