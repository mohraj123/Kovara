import { KovaraClient } from "../../../packages/sdk/src/client";
import type { WalletKitAdapter } from "../types/walletContext.types";

export interface CreatePostResult {
  postId: string;
  txHash: string;
}

export async function sdkCreatePost(
  contractId: string,
  rpcUrl: string,
  author: string,
  content: string,
  walletKit: WalletKitAdapter
): Promise<CreatePostResult> {
  // ── Validation ──────────────────────────────────────────────────────
  if (!content || content.trim().length === 0) {
    throw new Error("Post content cannot be empty.");
  }
  if (content.length > 280) {
    throw new Error(
      `Post content exceeds maximum length of 280 characters (${content.length} chars).`
    );
  }

  const client = new KovaraClient({ contractId, rpcUrl });
  const txXdr = client.createPost(author, content);

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

  return { postId: txHash.slice(0, 16), txHash };
}
