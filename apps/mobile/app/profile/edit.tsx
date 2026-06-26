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

import { useToast } from "../../context/ToastContext";
import { useWallet } from "../../hooks/useWallet";

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;

async function setProfileTransaction(
  _user: string,
  _username: string,
  _creatorToken: string
): Promise<string> {
  // Replace with SDK-backed set_profile submission once signing is wired.
  await new Promise<void>((resolve) => setTimeout(resolve, 800));
  return `mock_tx_${Date.now().toString(36)}`;
}

function validateUsername(value: string): string | null {
  if (!value.trim()) return "Username is required.";
  if (!USERNAME_RE.test(value)) {
    return "Username must be 3–32 characters: letters, numbers, or underscores only.";
  }
  return null;
}

export default function EditProfileScreen() {
  const router = useRouter();
  const { address, connected } = useWallet();
  const { showPending, showSuccess, showError } = useToast();

  const [username, setUsername] = useState("");
  const [creatorToken, setCreatorToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);

  const handleUsernameChange = (value: string) => {
    setUsername(value);
    if (usernameError) {
      setUsernameError(validateUsername(value));
    }
  };

  const handleSubmit = async () => {
    if (!connected || !address) {
      showError("Connect your wallet to edit your profile.");
      return;
    }

    const error = validateUsername(username);
    if (error) {
      setUsernameError(error);
      return;
    }

    setSubmitting(true);
    showPending();

    try {
      const txHash = await setProfileTransaction(address, username.trim(), creatorToken.trim());
      showSuccess(txHash);
      router.back();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update profile.";
      showError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <Text style={styles.heading} accessibilityRole="header" accessibilityLabel="Edit profile">
          Edit Profile
        </Text>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Username</Text>
          <TextInput
            style={[styles.input, usernameError ? styles.inputError : null]}
            placeholder="e.g. satoshi_nakamoto"
            placeholderTextColor="#64748b"
            value={username}
            onChangeText={handleUsernameChange}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!submitting}
            accessibilityLabel="Username"
            accessibilityHint="Choose a username with 3 to 32 letters, numbers, or underscores"
            accessibilityState={{ disabled: submitting }}
          />
          {usernameError ? (
            <Text
              style={styles.errorText}
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
            >
              {usernameError}
            </Text>
          ) : null}
          <Text style={styles.hint}>3–32 characters: letters, numbers, or underscores.</Text>
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Creator token address</Text>
          <TextInput
            style={styles.input}
            placeholder="GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
            placeholderTextColor="#64748b"
            value={creatorToken}
            onChangeText={setCreatorToken}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!submitting}
            accessibilityLabel="Creator token address"
            accessibilityHint="Paste the Stellar contract address of your creator token"
            accessibilityState={{ disabled: submitting }}
          />
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
