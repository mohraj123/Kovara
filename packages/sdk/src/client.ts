import {
  rpc,
  Contract,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
  Account,
  Keypair,
  xdr,
  Transaction,
} from "@stellar/stellar-sdk";
import { Profile, Post, Pool } from "./types";
import { mapError } from "./errors";

const { isSimulationError, isSimulationSuccess } = rpc.Api;

const DEFAULT_NETWORK = "Test SDF Network ; September 2015";

/** Duck-type guard: treats any object with a `sign` method as a Keypair. */
function isKeypair(v: unknown): v is Keypair {
  return (
    typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).sign === "function"
  );
}
const DEFAULT_TIMEOUT = 30;

function scvAddress(value: string): xdr.ScVal {
  return nativeToScVal(value, { type: "address" });
}

function scvString(value: string): xdr.ScVal {
  return nativeToScVal(value);
}

function scvU64(value: number): xdr.ScVal {
  return nativeToScVal(value);
}

function scvI128(value: number | bigint): xdr.ScVal {
  return nativeToScVal(value);
}

/**
 * Configuration options for the SDK client
 */
export interface ClientConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase?: string;
}

export interface SubmitResult {
  txHash: string;
}

export interface CreatePostResult extends SubmitResult {
  postId: number;
}

/**
 * Typed client for all Kovara social contract methods.
 *
 * Read methods call simulateTransaction on the Soroban RPC.
 * Write methods return a base64-encoded XDR transaction envelope
 * ready to be signed and submitted by the caller.
 *
 * This client is wired to the Soroban contract bindings from
 * packages/contracts/src/index.ts — regenerate that file after
 * every contract change with:
 *
 *   pnpm build:contracts && bash packages/sdk/generate.sh
 */
export class KovaraClient {
  private contractId: string;
  private rpcUrl: string;
  private networkPassphrase: string;

  constructor(config: ClientConfig) {
    this.contractId = config.contractId;
    this.rpcUrl = config.rpcUrl;
    this.networkPassphrase = config.networkPassphrase || DEFAULT_NETWORK;
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private async simulateCall(method: string, ...args: xdr.ScVal[]): Promise<xdr.ScVal | null> {
    const server = new rpc.Server(this.rpcUrl);
    const contract = new Contract(this.contractId);
    const op = contract.call(method, ...args);

    const source = Keypair.random();
    const account = new Account(source.publicKey(), "0");
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(DEFAULT_TIMEOUT)
      .build();

    const result = await server.simulateTransaction(tx);

    if (isSimulationError(result)) {
      throw mapError(result.error);
    }
    if (!isSimulationSuccess(result) || !result.result) return null;

    return result.result.retval;
  }

  private buildTx(method: string, ...args: xdr.ScVal[]): string {
    const contract = new Contract(this.contractId);
    const op = contract.call(method, ...args);

    const source = Keypair.random();
    const account = new Account(source.publicKey(), "0");
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(DEFAULT_TIMEOUT)
      .build();

    return tx.toEnvelope().toXDR("base64");
  }

  // ── Read: Profiles ──────────────────────────────────────────────────────────

  /**
   * Signs, submits, and confirms a base64-XDR transaction envelope.
   * @param keypair - The signing keypair
   * @param xdrEnvelope - Base64-encoded XDR transaction envelope
   * @returns The transaction hash
   */
  async submitTx(keypair: Keypair, xdrEnvelope: string): Promise<SubmitResult> {
    const server = new rpc.Server(this.rpcUrl);
    const tx = TransactionBuilder.fromXDR(xdrEnvelope, this.networkPassphrase) as Transaction;

    // Prepare (simulate + set resource fees) then sign
    const prepared = await server.prepareTransaction(tx);
    prepared.sign(keypair);

    const sendResult = await server.sendTransaction(prepared);
    if (sendResult.status === "ERROR") {
      throw mapError(sendResult.errorResult?.result().toString() ?? "Transaction failed");
    }

    // Poll for final status
    let getResult = await server.getTransaction(sendResult.hash);
    while (getResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
      await new Promise((r) => setTimeout(r, 1000));
      getResult = await server.getTransaction(sendResult.hash);
    }

    if (getResult.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw mapError("Transaction failed on-chain");
    }

    return { txHash: sendResult.hash };
  }

  // ─── read methods ─────────────────────────────────────────────────────────

  /**
   * Fetches a user profile by their address
   */
  async getProfile(address: string): Promise<Profile | null> {
    const retval = await this.simulateCall("get_profile", scvAddress(address));
    if (!retval) return null;
    const raw = scValToNative(retval);
    if (raw == null) return null;
    return raw as Profile;
  }

  /**
   * Fetches a post by its ID
   */
  async getPost(postId: number): Promise<Post | null> {
    const retval = await this.simulateCall("get_post", scvU64(postId));
    if (!retval) return null;
    const raw = scValToNative(retval);
    if (raw == null) return null;
    return raw as Post;
  }

  /**
   * Retrieves the total number of posts created
   */
  async getPostCount(): Promise<number> {
    const retval = await this.simulateCall("get_post_count");
    if (!retval) return 0;
    return Number(scValToNative(retval));
  }

  /**
   * Returns a paginated list of post IDs for an author.
   * offset and limit follow the same rules as the on-chain contract:
   * limit must be between 1 and 50 (inclusive).
   * Fetches the addresses of users that a specific address is following
   */
  async getPostsByAuthor(author: string, offset: number, limit: number): Promise<number[]> {
    const retval = await this.simulateCall(
      "get_posts_by_author",
      scvAddress(author),
      nativeToScVal(offset, { type: "u32" }),
      nativeToScVal(limit, { type: "u32" })
    );
    if (!retval) return [];
    return scValToNative(retval) as number[];
  }

  async getFollowing(address: string): Promise<string[]> {
    const retval = await this.simulateCall("get_following", scvAddress(address));
    if (!retval) return [];
    return scValToNative(retval) as string[];
  }

  /**
   * Fetches the addresses of users following a specific address
   */
  async getFollowers(address: string): Promise<string[]> {
    const retval = await this.simulateCall("get_followers", scvAddress(address));
    if (!retval) return [];
    return scValToNative(retval) as string[];
  }

  /**
   * Fetches a pool by its ID
   */
  async getPool(poolId: string): Promise<Pool | null> {
    const retval = await this.simulateCall("get_pool", scvString(poolId));
    if (!retval) return null;
    const raw = scValToNative(retval);
    if (raw == null) return null;
    return raw as Pool;
  }

  /**
   * Retrieves the administrators of a specific pool
   */
  async getPoolAdmins(poolId: string): Promise<string[]> {
    const retval = await this.simulateCall("get_pool_admins", scvString(poolId));
    if (!retval) return [];
    return scValToNative(retval) as string[];
  }

  /**
   * Fetches the global platform fee in basis points
   */
  async getFeeBps(): Promise<number> {
    const retval = await this.simulateCall("get_fee_bps");
    if (!retval) return 0;
    return Number(scValToNative(retval));
  }

  /**
   * Fetches the treasury address
   */
  async getTreasury(): Promise<string> {
    const retval = await this.simulateCall("get_treasury");
    if (!retval) return "";
    return scValToNative(retval) as string;
  }

  /**
   * Checks if a specific address has liked a specific post
   */
  async hasLiked(address: string, postId: number): Promise<boolean> {
    const retval = await this.simulateCall("has_liked", scvAddress(address), scvU64(postId));
    if (!retval) return false;
    return scValToNative(retval) as boolean;
  }

  /**
   * Checks if a user has blocked another user
   */
  async isBlocked(blocker: string, blocked: string): Promise<boolean> {
    const retval = await this.simulateCall("is_blocked", scvAddress(blocker), scvAddress(blocked));
    if (!retval) return false;
    return scValToNative(retval) as boolean;
  }

  /**
   * Fetches the number of likes a post has received
   */
  async getLikeCount(postId: number): Promise<number> {
    const retval = await this.simulateCall("get_like_count", scvU64(postId));
    if (!retval) return 0;
    return Number(scValToNative(retval));
  }

  // ── Write: returns base64 XDR envelope for caller to sign + submit ──────────

  createPost(author: string, content: string): string {
    return this.buildTx("create_post", scvAddress(author), scvString(content));
  }

  deletePost(author: string, postId: number): string {
    return this.buildTx("delete_post", scvAddress(author), scvU64(postId));
  }

  follow(follower: string, followed: string): string {
    return this.buildTx("follow", scvAddress(follower), scvAddress(followed));
  }

  unfollow(follower: string, followed: string): string {
    return this.buildTx("unfollow", scvAddress(follower), scvAddress(followed));
  }

  tip(sender: string, postId: number, amount: number | bigint): string {
    return this.buildTx("tip", scvAddress(sender), scvU64(postId), scvI128(amount));
  }

  // ─── write methods ────────────────────────────────────────────────────────
  //
  // Each write method has two overloads:
  //   (a) No keypair → returns base64 XDR string (wallet-agnostic, unchanged behaviour)
  //   (b) With keypair → signs + submits → returns SubmitResult / CreatePostResult

  /**
   * Creates a post. With a keypair, signs and submits; otherwise returns XDR.
   */
  async createPost(
    keypair: Keypair,
    author: string,
    params: { author: string; content: string }
  ): Promise<CreatePostResult>;
  createPost(author: string, content: string): string;
  createPost(
    keypairOrAuthor: Keypair | string,
    authorOrContent: string,
    params?: { author: string; content: string }
  ): Promise<CreatePostResult> | string {
    if (isKeypair(keypairOrAuthor) && params) {
      const xdrEnv = this.buildTx(
        "create_post",
        scvAddress(params.author),
        scvString(params.content)
      );
      return this.submitTx(keypairOrAuthor, xdrEnv).then(async (res) => {
        const count = await this.getPostCount();
        return { ...res, postId: count };
      });
    }
    return this.buildTx(
      "create_post",
      scvAddress(keypairOrAuthor as string),
      scvString(authorOrContent)
    );
  }

  /**
   * Deletes a post. With a keypair, signs and submits; otherwise returns XDR.
   */
  async deletePost(keypair: Keypair, author: string, postId: number): Promise<SubmitResult>;
  deletePost(author: string, postId: number): string;
  deletePost(
    keypairOrAuthor: Keypair | string,
    authorOrPostId: string | number,
    postId?: number
  ): Promise<SubmitResult> | string {
    if (isKeypair(keypairOrAuthor)) {
      const xdrEnv = this.buildTx(
        "delete_post",
        scvAddress(authorOrPostId as string),
        scvU64(postId!)
      );
      return this.submitTx(keypairOrAuthor, xdrEnv);
    }
    return this.buildTx(
      "delete_post",
      scvAddress(keypairOrAuthor as string),
      scvU64(authorOrPostId as number)
    );
  }

  /**
   * Follows a user. With a keypair, signs and submits; otherwise returns XDR.
   */
  async follow(keypair: Keypair, follower: string, followed: string): Promise<SubmitResult>;
  follow(follower: string, followed: string): string;
  follow(
    keypairOrFollower: Keypair | string,
    followerOrFollowed: string,
    followed?: string
  ): Promise<SubmitResult> | string {
    if (isKeypair(keypairOrFollower)) {
      const xdrEnv = this.buildTx("follow", scvAddress(followerOrFollowed), scvAddress(followed!));
      return this.submitTx(keypairOrFollower, xdrEnv);
    }
    return this.buildTx(
      "follow",
      scvAddress(keypairOrFollower as string),
      scvAddress(followerOrFollowed)
    );
  }

  /**
   * Unfollows a user. With a keypair, signs and submits; otherwise returns XDR.
   */
  async unfollow(keypair: Keypair, follower: string, followed: string): Promise<SubmitResult>;
  unfollow(follower: string, followed: string): string;
  unfollow(
    keypairOrFollower: Keypair | string,
    followerOrFollowed: string,
    followed?: string
  ): Promise<SubmitResult> | string {
    if (isKeypair(keypairOrFollower)) {
      const xdrEnv = this.buildTx(
        "unfollow",
        scvAddress(followerOrFollowed),
        scvAddress(followed!)
      );
      return this.submitTx(keypairOrFollower, xdrEnv);
    }
    return this.buildTx(
      "unfollow",
      scvAddress(keypairOrFollower as string),
      scvAddress(followerOrFollowed)
    );
  }

  /**
   * Likes a post. With a keypair, signs and submits; otherwise returns XDR.
   */
  async like(keypair: Keypair, liker: string, postId: number): Promise<SubmitResult>;
  like(liker: string, postId: number): string;
  like(
    keypairOrLiker: Keypair | string,
    likerOrPostId: string | number,
    postId?: number
  ): Promise<SubmitResult> | string {
    if (isKeypair(keypairOrLiker)) {
      const xdrEnv = this.buildTx("like", scvAddress(likerOrPostId as string), scvU64(postId!));
      return this.submitTx(keypairOrLiker, xdrEnv);
    }
    return this.buildTx(
      "like",
      scvAddress(keypairOrLiker as string),
      scvU64(likerOrPostId as number)
    );
  }

  /**
   * Unlikes a post. With a keypair, signs and submits; otherwise returns XDR.
   */
  async unlike(keypair: Keypair, liker: string, postId: number): Promise<SubmitResult>;
  unlike(liker: string, postId: number): string;
  unlike(
    keypairOrLiker: Keypair | string,
    likerOrPostId: string | number,
    postId?: number
  ): Promise<SubmitResult> | string {
    if (isKeypair(keypairOrLiker)) {
      const xdrEnv = this.buildTx("unlike", scvAddress(likerOrPostId as string), scvU64(postId!));
      return this.submitTx(keypairOrLiker, xdrEnv);
    }
    return this.buildTx(
      "unlike",
      scvAddress(keypairOrLiker as string),
      scvU64(likerOrPostId as number)
    );
  }

  /**
   * Tips a post. With a keypair, signs and submits; otherwise returns XDR.
   */
  async tip(
    keypair: Keypair,
    sender: string,
    postId: number,
    amount: number | bigint
  ): Promise<SubmitResult>;
  tip(sender: string, postId: number, amount: number | bigint): string;
  tip(
    keypairOrSender: Keypair | string,
    senderOrPostId: string | number,
    postIdOrAmount: number | bigint,
    amount?: number | bigint
  ): Promise<SubmitResult> | string {
    if (isKeypair(keypairOrSender)) {
      const xdrEnv = this.buildTx(
        "tip",
        scvAddress(senderOrPostId as string),
        scvU64(postIdOrAmount as number),
        scvI128(amount!)
      );
      return this.submitTx(keypairOrSender, xdrEnv);
    }
    return this.buildTx(
      "tip",
      scvAddress(keypairOrSender as string),
      scvU64(senderOrPostId as number),
      scvI128(postIdOrAmount)
    );
  }

  /**
   * Creates a pool. With a keypair, signs and submits; otherwise returns XDR.
   */
  async createPool(
    keypair: Keypair,
    admin: string,
    token: string,
    initialAdmins: string[],
    threshold: number
  ): Promise<SubmitResult>;
  createPool(admin: string, token: string, initialAdmins: string[], threshold: number): string;
  createPool(
    keypairOrAdmin: Keypair | string,
    adminOrToken: string,
    tokenOrAdmins: string | string[],
    adminsOrThreshold: string[] | number,
    threshold?: number
  ): Promise<SubmitResult> | string {
    if (isKeypair(keypairOrAdmin)) {
      const xdrEnv = this.buildTx(
        "create_pool",
        scvAddress(adminOrToken),
        scvString(tokenOrAdmins as string),
        nativeToScVal(
          (adminsOrThreshold as string[]).map((a) => scvAddress(a)),
          { type: "vec" }
        ),
        scvU64(threshold!)
      );
      return this.submitTx(keypairOrAdmin, xdrEnv);
    }
    return this.buildTx(
      "create_pool",
      scvAddress(keypairOrAdmin as string),
      scvString(adminOrToken),
      nativeToScVal(
        initialAdmins.map((a) => scvAddress(a)),
        (tokenOrAdmins as string[]).map((a) => scvAddress(a)),
        { type: "vec" }
      ),
      scvU64(adminsOrThreshold as number)
    );
  }

  /**
   * Deposits into a pool. With a keypair, signs and submits; otherwise returns XDR.
   */
  async deposit(
    keypair: Keypair,
    depositor: string,
    poolId: string,
    token: string,
    amount: number | bigint
  ): Promise<SubmitResult>;
  deposit(depositor: string, poolId: string, token: string, amount: number | bigint): string;
  deposit(
    keypairOrDepositor: Keypair | string,
    depositorOrPoolId: string,
    poolIdOrToken: string,
    tokenOrAmount: string | number | bigint,
    amount?: number | bigint
  ): Promise<SubmitResult> | string {
    if (isKeypair(keypairOrDepositor)) {
      const xdrEnv = this.buildTx(
        "deposit",
        scvAddress(depositorOrPoolId),
        scvString(poolIdOrToken),
        scvString(tokenOrAmount as string),
        scvI128(amount!)
      );
      return this.submitTx(keypairOrDepositor, xdrEnv);
    }
    return this.buildTx(
      "deposit",
      scvAddress(keypairOrDepositor as string),
      scvString(depositorOrPoolId),
      scvString(poolIdOrToken),
      scvI128(tokenOrAmount as number | bigint)
    );
  }

  /**
   * Withdraws from a pool. With a keypair, signs and submits; otherwise returns XDR.
   */
  async withdraw(
    keypair: Keypair,
    signers: string[],
    poolId: string,
    amount: number | bigint,
    recipient: string
  ): Promise<SubmitResult>;
  withdraw(signers: string[], poolId: string, amount: number | bigint, recipient: string): string;
  withdraw(
    keypairOrSigners: Keypair | string[],
    signersOrPoolId: string[] | string,
    poolIdOrAmount: string | number | bigint,
    amountOrRecipient: number | bigint | string,
    recipient?: string
  ): Promise<SubmitResult> | string {
    if (isKeypair(keypairOrSigners)) {
      const xdrEnv = this.buildTx(
        "withdraw",
        nativeToScVal(
          (signersOrPoolId as string[]).map((s) => scvAddress(s)),
          { type: "vec" }
        ),
        scvString(poolIdOrAmount as string),
        scvI128(amountOrRecipient as number | bigint),
        scvAddress(recipient!)
      );
      return this.submitTx(keypairOrSigners, xdrEnv);
    }
    return this.buildTx(
      "withdraw",
      nativeToScVal(
        (keypairOrSigners as string[]).map((s) => scvAddress(s)),
        { type: "vec" }
      ),
      scvString(signersOrPoolId as string),
      scvI128(poolIdOrAmount as number | bigint),
      scvAddress(amountOrRecipient as string)
    );
  }

  /**
   * Sets a user profile. With a keypair, signs and submits; otherwise returns XDR.
   */
  async setProfile(
    keypair: Keypair,
    user: string,
    params: { user: string; username: string; creator_token: string }
  ): Promise<SubmitResult>;
  setProfile(user: string, username: string, creatorToken: string): string;
  setProfile(
    keypairOrUser: Keypair | string,
    userOrUsername: string,
    paramsOrCreatorToken: { user: string; username: string; creator_token: string } | string
  ): Promise<SubmitResult> | string {
    if (isKeypair(keypairOrUser)) {
      const p = paramsOrCreatorToken as { user: string; username: string; creator_token: string };
      const xdrEnv = this.buildTx(
        "set_profile",
        scvAddress(p.user),
        scvString(p.username),
        scvAddress(p.creator_token)
      );
      return this.submitTx(keypairOrUser, xdrEnv);
    }
    return this.buildTx(
      "set_profile",
      scvAddress(keypairOrUser as string),
      scvString(userOrUsername),
      scvAddress(paramsOrCreatorToken as string)
    );
  }

  /**
   * Blocks a user. With a keypair, signs and submits; otherwise returns XDR.
   */
  async block(keypair: Keypair, blocker: string, blocked: string): Promise<SubmitResult>;
  block(blocker: string, blocked: string): string;
  block(
    keypairOrBlocker: Keypair | string,
    blockerOrBlocked: string,
    blocked?: string
  ): Promise<SubmitResult> | string {
    if (isKeypair(keypairOrBlocker)) {
      const xdrEnv = this.buildTx("block", scvAddress(blockerOrBlocked), scvAddress(blocked!));
      return this.submitTx(keypairOrBlocker, xdrEnv);
    }
    return this.buildTx(
      "block",
      scvAddress(keypairOrBlocker as string),
      scvAddress(blockerOrBlocked)
    );
  }

  /**
   * Unblocks a user. With a keypair, signs and submits; otherwise returns XDR.
   */
  async unblock(keypair: Keypair, blocker: string, blocked: string): Promise<SubmitResult>;
  unblock(blocker: string, blocked: string): string;
  unblock(
    keypairOrBlocker: Keypair | string,
    blockerOrBlocked: string,
    blocked?: string
  ): Promise<SubmitResult> | string {
    if (isKeypair(keypairOrBlocker)) {
      const xdrEnv = this.buildTx("unblock", scvAddress(blockerOrBlocked), scvAddress(blocked!));
      return this.submitTx(keypairOrBlocker, xdrEnv);
    }
    return this.buildTx(
      "unblock",
      scvAddress(keypairOrBlocker as string),
      scvAddress(blockerOrBlocked)
    );
  }
}
