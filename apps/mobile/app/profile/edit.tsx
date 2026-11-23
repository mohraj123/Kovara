import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useRouter } from "expo-router";

import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  validateBannerUrl,
  validateUsername,
} from "../../components/ProfileHeader";
import { useUpdateProfile } from "../../hooks/useProfile";

/** Stellar / Soroban address: G… or C… followed by 55 base-32 chars. */
const STELLAR_ADDRESS_RE = /^[GC][A-Z2-7]{55}$/;

type Field = "username" | "bannerUrl" | "creatorToken";
type FieldErrors = Partial<Record<Field, string>>;

/** Creator token is optional; an empty value is valid. */
function validateCreatorToken(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!STELLAR_ADDRESS_RE.test(trimmed)) {
    return "Enter a valid Stellar address (starts with G or C, 56 characters).";
  }
  return null;
}

const VALIDATORS: Record<Field, (value: string) => string | null> = {
  username: validateUsername,
  bannerUrl: validateBannerUrl,
  creatorToken: validateCreatorToken,
};

export function validateProfileForm(values: Record<Field, string>): FieldErrors {
  const errors: FieldErrors = {};
  (Object.keys(VALIDATORS) as Field[]).forEach((field) => {
    const error = VALIDATORS[field](values[field]);
    if (error) errors[field] = error;
  });
  return errors;
}

export default function EditProfileScreen() {
  const router = useRouter();
  const { saving: submitting, saveError, saveProfile, clearSaveError } = useUpdateProfile();

  const [values, setValues] = useState<Record<Field, string>>({
    username: "",
    bannerUrl: "",
    creatorToken: "",
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const { username, bannerUrl, creatorToken } = values;

  const handleChange = (field: Field) => (value: string) => {
    setValues((prev) => ({ ...prev, [field]: value }));
    // Only re-validate live once a field has been flagged, so users aren't
    // nagged while typing for the first time.
    if (fieldErrors[field]) {
      setFieldErrors((prev) => ({ ...prev, [field]: VALIDATORS[field](value) ?? undefined }));
    }
    // A save failure caused by this field is resolved by editing it.
    if (saveError?.field === field) {
      clearSaveError();
    }
  };

  const handleSubmit = async () => {
    const errors = validateProfileForm(values);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    // On failure the hook keeps `saveError` and we stay on this screen with
    // the user's edits intact so they can fix and retry.
    const txHash = await saveProfile(values);
    if (txHash) router.back();
  };

  const usernameError =
    fieldErrors.username ?? (saveError?.field === "username" ? saveError.message : undefined);
  const creatorTokenError =
    fieldErrors.creatorToken ?? (saveError?.field === "creatorToken" ? saveError.message : undefined);
  const bannerUrlError = fieldErrors.bannerUrl;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <Text style={styles.heading} accessibilityRole="header" accessibilityLabel="Edit profile">
          Edit Profile
        </Text>

        {saveError ? (
          <View
            style={styles.saveErrorBanner}
            testID="profile-save-error"
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
          >
            <Text style={styles.saveErrorTitle}>Profile not saved</Text>
            <Text style={styles.saveErrorMessage}>{saveError.message}</Text>
            {saveError.detail && saveError.detail !== saveError.message ? (
              <Text style={styles.saveErrorDetail} selectable testID="profile-save-error-detail">
                {saveError.detail}
              </Text>
            ) : null}
            <Text style={styles.saveErrorHint}>Your changes are still here. Fix any issues and try again.</Text>
          </View>
        ) : null}

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Username</Text>
          <TextInput
            style={[styles.input, usernameError ? styles.inputError : null]}
            placeholder="e.g. satoshi_nakamoto"
            placeholderTextColor="#64748b"
            value={username}
            onChangeText={handleChange("username")}
            maxLength={USERNAME_MAX_LENGTH}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!submitting}
            accessibilityLabel="Username"
            accessibilityHint={`Choose a username with ${USERNAME_MIN_LENGTH} to ${USERNAME_MAX_LENGTH} letters, numbers, or underscores`}
            accessibilityState={{ disabled: submitting }}
          />
          {usernameError ? (
            <Text
              style={styles.errorText}
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              testID="username-error"
            >
              {usernameError}
            </Text>
          ) : null}
          <Text style={styles.hint}>
            {USERNAME_MIN_LENGTH}–{USERNAME_MAX_LENGTH} characters: letters, numbers, or underscores.
          </Text>
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Banner URL</Text>
          <TextInput
            style={[styles.input, bannerUrlError ? styles.inputError : null]}
            placeholder="https://example.com/banner.jpg"
            placeholderTextColor="#64748b"
            value={bannerUrl}
            onChangeText={handleChange("bannerUrl")}
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!submitting}
            accessibilityLabel="Profile banner URL"
            accessibilityHint="Enter a URL for your profile cover image"
            accessibilityState={{ disabled: submitting }}
          />
          {bannerUrlError ? (
            <Text
              style={styles.errorText}
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              testID="banner-url-error"
            >
              {bannerUrlError}
            </Text>
          ) : null}
          <Text style={styles.hint}>Optional http(s) image URL shown at the top of your profile.</Text>
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Creator token address</Text>
          <TextInput
            style={[styles.input, creatorTokenError ? styles.inputError : null]}
            placeholder="GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
            placeholderTextColor="#64748b"
            value={creatorToken}
            onChangeText={handleChange("creatorToken")}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!submitting}
            accessibilityLabel="Creator token address"
            accessibilityHint="Paste the Stellar contract address of your creator token"
            accessibilityState={{ disabled: submitting }}
          />
          {creatorTokenError ? (
            <Text
              style={styles.errorText}
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              testID="creator-token-error"
            >
              {creatorTokenError}
            </Text>
          ) : null}
          <Text style={styles.hint}>Stellar contract address for your creator token.</Text>
        </View>

        <TouchableOpacity
          style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
          onPress={handleSubmit}
          disabled={submitting}
          accessibilityRole="button"
          accessibilityLabel="Save profile"
          accessibilityHint="Submits your profile changes to the network"
          accessibilityState={{ disabled: submitting, busy: submitting }}
        >
          {submitting ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text style={styles.submitText}>Save changes</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.cancelButton}
          onPress={() => router.back()}
          disabled={submitting}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          accessibilityHint="Returns to the previous screen without saving"
          accessibilityState={{ disabled: submitting }}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f172a",
  },
  scrollContent: {
    padding: 24,
  },
  heading: {
    fontSize: 24,
    fontWeight: "800",
    color: "#f1f5f9",
    marginBottom: 28,
  },
  fieldGroup: {
    marginBottom: 24,
  },
  saveErrorBanner: {
    backgroundColor: "#450a0a",
    borderColor: "#f87171",
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginBottom: 24,
  },
  saveErrorTitle: {
    color: "#fecaca",
    fontSize: 14,
    fontWeight: "800",
    marginBottom: 4,
  },
  saveErrorMessage: {
    color: "#fee2e2",
    fontSize: 14,
  },
  saveErrorDetail: {
    color: "#fca5a5",
    fontSize: 12,
    fontFamily: "monospace",
    marginTop: 8,
  },
  saveErrorHint: {
    color: "#fca5a5",
    fontSize: 12,
    marginTop: 8,
  },
  label: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  input: {
    backgroundColor: "#1e293b",
    borderRadius: 12,
    padding: 16,
    fontSize: 15,
    color: "#f1f5f9",
    borderWidth: 1,
    borderColor: "#334155",
  },
  inputError: {
    borderColor: "#f87171",
  },
  errorText: {
    color: "#f87171",
    fontSize: 12,
    marginTop: 6,
  },
  hint: {
    color: "#64748b",
    fontSize: 12,
    marginTop: 6,
  },
  submitButton: {
    backgroundColor: "#6366f1",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 8,
  },
  submitButtonDisabled: {
    opacity: 0.6,
  },
  submitText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "700",
  },
  cancelButton: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: "#334155",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  cancelText: {
    color: "#e2e8f0",
    fontWeight: "600",
    fontSize: 15,
  },
});
