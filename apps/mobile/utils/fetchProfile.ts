import { KovaraClient } from "../../../packages/sdk/src/client";

export interface ProfileData {
  address: string;
  username: string | null;
  bio: string | null;
}

export async function fetchProfile(
  address: string,
  contractId: string,
  rpcUrl: string
): Promise<ProfileData | null> {
  if (!address) return null;

  const client = new KovaraClient({ contractId, rpcUrl });
  const raw = await client.getProfile(address);

  if (!raw) return null;

  return {
    address,
    username: raw.username ?? null,
    bio: (raw.bio as string) ?? null,
  };
}