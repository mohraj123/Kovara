'use client';

import { useState } from 'react';
import { validateBannerUrl, validateUsername, validateStellarAddress } from '@/lib/validate';
import { sanitizeBannerUrl } from '@/utils/sanitizeUrl';
import { FieldError } from './FieldError';

export interface ProfileFormValues {
  username: string;
  creatorToken: string;
  bannerUrl: string;
}

interface ProfileFormProps {
  /** Called with validated values on successful submission. */
  onSubmit: (values: ProfileFormValues) => void | Promise<void>;
  initialValues?: Partial<ProfileFormValues>;
  disabled?: boolean;
}

interface FormErrors {
  username?: string;
  creatorToken?: string;
  bannerUrl?: string;
}

export function ProfileForm({ onSubmit, initialValues = {}, disabled = false }: ProfileFormProps) {
  const [username, setUsername] = useState(initialValues.username ?? '');
  const [creatorToken, setCreatorToken] = useState(initialValues.creatorToken ?? '');
  const [bannerUrl, setBannerUrl] = useState(initialValues.bannerUrl ?? '');
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);

  function validate(): FormErrors {
    const errs: FormErrors = {};
    const usernameResult = validateUsername(username);
    if (!usernameResult.valid) errs.username = usernameResult.error;
    // creatorToken is optional — only validate if provided
    if (creatorToken.trim()) {
      const addrResult = validateStellarAddress(creatorToken);
      if (!addrResult.valid) errs.creatorToken = addrResult.error;
    }
    if (bannerUrl.trim()) {
      // FE-28: delegate to the shared validator, which is the same rule the
      // banner is rendered through. The inline protocol check this replaces
      // skipped the 2048-character ceiling, so a URL the form accepted was
      // silently dropped at render time.
      const bannerResult = validateBannerUrl(bannerUrl);
      if (!bannerResult.valid) errs.bannerUrl = bannerResult.error;
    }
    return errs;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setSubmitting(true);
    try {
      // The submitted banner URL is passed through the same sanitiser the
      // renderer uses, so what is saved is exactly what will be displayed
      // (FE-28). Validation above already rejects anything unsafe, so an empty
      // result here can only mean the field was left blank.
      const sanitizedBanner = sanitizeBannerUrl(bannerUrl.trim());
      await onSubmit({
        username: username.trim(),
        creatorToken: creatorToken.trim(),
        bannerUrl: sanitizedBanner,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate aria-label="Edit profile" className="flex flex-col gap-4">
      {/* Username */}
      <div>
        <label htmlFor="profile-username" className="block text-sm font-medium mb-1">
          Username <span aria-hidden="true" className="text-red-500">*</span>
        </label>
        <input
          id="profile-username"
          name="username"
          type="text"
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            if (errors.username) setErrors((prev) => ({ ...prev, username: undefined }));
          }}
          disabled={disabled || submitting}
          aria-required="true"
          aria-describedby={errors.username ? 'profile-username-error' : undefined}
          aria-invalid={!!errors.username}
          placeholder="e.g. alice_stellar"
          className={`w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:opacity-50 ${
            errors.username ? 'border-red-500' : 'border-gray-300'
          }`}
        />
        <FieldError id="profile-username-error" message={errors.username} />
      </div>

      {/* Creator token (Stellar address) */}
      <div>
        <label htmlFor="profile-banner-url" className="block text-sm font-medium mb-1">
          Banner URL{' '}
          <span className="text-xs text-gray-500 font-normal">(optional)</span>
        </label>
        <input
          id="profile-banner-url"
          name="bannerUrl"
          type="url"
          value={bannerUrl}
          onChange={(e) => {
            setBannerUrl(e.target.value);
            if (errors.bannerUrl) setErrors((prev) => ({ ...prev, bannerUrl: undefined }));
          }}
          disabled={disabled || submitting}
          aria-describedby={errors.bannerUrl ? 'profile-banner-url-error' : 'profile-banner-url-hint'}
          aria-invalid={!!errors.bannerUrl}
          placeholder="https://example.com/cover.jpg"
          className={`w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:opacity-50 ${
            errors.bannerUrl ? 'border-red-500' : 'border-gray-300'
          }`}
        />
        {!errors.bannerUrl && (
          <p id="profile-banner-url-hint" className="mt-1 text-xs text-gray-500">
            Optional cover image shown at the top of your profile.
          </p>
        )}
        <FieldError id="profile-banner-url-error" message={errors.bannerUrl} />
      </div>

      <div>
        <label htmlFor="profile-creator-token" className="block text-sm font-medium mb-1">
          Creator Token Address{' '}
          <span className="text-xs text-gray-500 font-normal">(optional — your SEP-41 token)</span>
        </label>
        <input
          id="profile-creator-token"
          name="creatorToken"
          type="text"
          value={creatorToken}
          onChange={(e) => {
            setCreatorToken(e.target.value);
            if (errors.creatorToken) setErrors((prev) => ({ ...prev, creatorToken: undefined }));
          }}
          disabled={disabled || submitting}
          aria-describedby={errors.creatorToken ? 'profile-creator-token-error' : 'profile-creator-token-hint'}
          aria-invalid={!!errors.creatorToken}
          placeholder="GABC…XYZ"
          className={`w-full rounded-lg border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:opacity-50 ${
            errors.creatorToken ? 'border-red-500' : 'border-gray-300'
          }`}
        />
        {!errors.creatorToken && (
          <p id="profile-creator-token-hint" className="mt-1 text-xs text-gray-500">
            Starts with G or C, 56 characters. Leave blank to use your wallet address.
          </p>
        )}
        <FieldError id="profile-creator-token-error" message={errors.creatorToken} />
      </div>

      <button
        type="submit"
        disabled={disabled || submitting}
        className="px-4 py-2 bg-violet-600 text-white text-sm font-medium rounded-lg hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? 'Saving…' : 'Save Profile'}
      </button>
    </form>
  );
}
