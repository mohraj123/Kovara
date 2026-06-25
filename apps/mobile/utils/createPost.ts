import { KovaraClient } from "../../../packages/sdk/src/client";

interface WalletKit {
  signAndSubmitTransaction?: (opts: { txXdr: string; rpcUrl?: string }) => Promise<{ hash?: string; txHash?: string }>;
  signTransaction?: (opts: { txXdr: string }) => Promise<{ signedTxXdr: string }>;
}

export interface CreatePostOptions {
  contractId: string;
  rpcUrl: string;
  author: string;
  content: string;
}

export async function createPost(opts: CreatePostOptions): Promise<string> {
  const { contractId, rpcUrl, author, content } = opts;
  const client = new KovaraClient({ contractId, rpcUrl });
  const txXdr = client.createPost(author, content);

  const kit = (globalThis as unknown as { __Kovara_WALLET_KIT__?: WalletKit }).__Kovara_WALLET_KIT__;
  if (!kit) throw new Error("Wallet not connected");

  if (typeof kit.signAndSubmitTransaction === "function") {
    const res = await kit.signAndSubmitTransaction({ txXdr, rpcUrl });
    return res?.hash ?? res?.txHash ?? "";
  }

  if (typeof kit.signTransaction === "function") {
    const signed = await kit.signTransaction({ txXdr });
    const { rpc } = await import("@stellar/stellar-sdk");
    const server = new rpc.Server(rpcUrl);
    const res = await server.submitTransaction(signed.signedTxXdr);
    return res?.hash ?? "";
  }

  throw new Error("Wallet signing not available");
}