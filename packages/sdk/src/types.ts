/**
 * Types representing the data structures returned by the smart contracts
 */

export interface Profile {
  address: string;
  username: string;
  creator_token: string;
  follower_count: number;
  following_count: number;
}

export interface Post {
  id: number;
  author: string;
  username: string;
  content: string;
  tip_total: number;
  timestamp: number;
  like_count: number;
}

export interface Pool {
  pool_id: string;
  token: string;
  balance: bigint;
  admins: string[];
  threshold: number;
}
