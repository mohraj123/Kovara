'use client';

import { useEffect, useState } from 'react';
import { ProfileForm, ProfileFormValues } from '@/components/forms/ProfileForm';
import { useWallet } from '@/hooks/useWallet';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProfileData {
  username: string;
  creatorToken: string;
}

// ── Contract stubs ───────────────────────────────────────────────────────────

async function getProfile(address: string): Promise<ProfileData | null> {
  /**
   * TODO: Replace with actual Soroban invocation once contract client
   * is available, e.g.:
   *   const client = await ProfileClient.deploy(contractId, { address });
   *   return client.get_profile({ address });
   */
  const contractId = process.env.NEXT_PUBLIC_PROFILE_CONTRACT_ID;
  if (!contractId) throw new Error('Profile contract not configured');

  // Stub: no existing profile for new users
  return null;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ProfileEditPage() {
  const { address, connected } = useWallet();
  const [initialValues, setInitialValues] = useState<Partial<ProfileFormValues> | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!address) return;

    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    getProfile(address)
      .then((profile) => {
        if (cancelled) return;
        setInitialValues({
          username: profile?.username ?? '',
          creatorToken: profile?.creatorToken ?? '',
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error('Failed to load profile:', err);
        setLoadError('Could not load your profile. You can still fill in the form.');
        setInitialValues({});
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [address]);

  async function handleSubmit(values: ProfileFormValues) {
    if (!address) return;
    console.log('set_profile', { address, ...values });
  }

  if (!connected || !address) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-md">
        <p className="text-gray-600">Connect your wallet to create or edit your profile.</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-md">
      <h1 className="text-2xl font-bold mb-6">Edit Profile</h1>

      {loadError && (
        <p role="alert" className="mb-4 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {loadError}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading profile…</p>
      ) : (
        <ProfileForm
          onSubmit={handleSubmit}
          initialValues={initialValues}
          disabled={loading}
        />
      )}
    </div>
  );
}