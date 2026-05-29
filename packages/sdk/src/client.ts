import { Profile, Post, Pool } from './types';

/**
 * Configuration options for the SDK client
 */
export interface ClientConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase?: string;
}

/**
 * Typed client for all Linkora social contract read methods
 */
export class LinkoraClient {
  private contractId: string;
  private rpcUrl: string;
  private networkPassphrase?: string;

  constructor(config: ClientConfig) {
    this.contractId = config.contractId;
    this.rpcUrl = config.rpcUrl;
    this.networkPassphrase = config.networkPassphrase;
  }

  /**
   * Fetches a user profile by their address
   * @param address - The Stellar address of the user
   * @returns A promise resolving to the user Profile, or null if not found
   */
  async getProfile(address: string): Promise<Profile | null> {
    throw new Error('Not implemented.');
  }

  /**
   * Fetches a post by its ID
   * @param postId - The ID of the post
   * @returns A promise resolving to the Post data, or null if not found
   */
  async getPost(postId: number): Promise<Post | null> {
    throw new Error('Not implemented.');
  }

  /**
   * Retrieves the total number of posts created
   * @returns A promise resolving to the total post count
   */
  async getPostCount(): Promise<number> {
    throw new Error('Not implemented.');
  }

  /**
   * Fetches the addresses of users that a specific address is following
   * @param address - The address of the follower
   * @returns A promise resolving to an array of addresses
   */
  async getFollowing(address: string): Promise<string[]> {
    throw new Error('Not implemented.');
  }

  /**
   * Fetches the addresses of users following a specific address
   * @param address - The address of the user being followed
   * @returns A promise resolving to an array of addresses
   */
  async getFollowers(address: string): Promise<string[]> {
    throw new Error('Not implemented.');
  }

  /**
   * Fetches a pool by its ID
   * @param poolId - The ID of the pool
   * @returns A promise resolving to the Pool data, or null if not found
   */
  async getPool(poolId: string): Promise<Pool | null> {
    throw new Error('Not implemented.');
  }

  /**
   * Retrieves the administrators of a specific pool
   * @param poolId - The ID of the pool
   * @returns A promise resolving to an array of admin addresses
   */
  async getPoolAdmins(poolId: string): Promise<string[]> {
    throw new Error('Not implemented.');
  }

  /**
   * Fetches the global platform fee in basis points
   * @returns A promise resolving to the fee in BPS
   */
  async getFeeBps(): Promise<number> {
    throw new Error('Not implemented.');
  }

  /**
   * Fetches the treasury address
   * @returns A promise resolving to the treasury address
   */
  async getTreasury(): Promise<string> {
    throw new Error('Not implemented.');
  }

  /**
   * Checks if a specific address has liked a specific post
   * @param address - The address of the user
   * @param postId - The ID of the post
   * @returns A promise resolving to true if liked, false otherwise
   */
  async hasLiked(address: string, postId: number): Promise<boolean> {
    throw new Error('Not implemented.');
  }

  /**
   * Checks if a user has blocked another user
   * @param blocker - The address of the user who is blocking
   * @param blocked - The address of the user who is blocked
   * @returns A promise resolving to true if blocked, false otherwise
   */
  async isBlocked(blocker: string, blocked: string): Promise<boolean> {
    throw new Error('Not implemented.');
  }

  /**
   * Fetches the number of likes a post has received
   * @param postId - The ID of the post
   * @returns A promise resolving to the like count
   */
  async getLikeCount(postId: number): Promise<number> {
    throw new Error('Not implemented.');
  }
}
