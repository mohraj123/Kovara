import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";

import { EmptyState } from "../../components/states/EmptyState";
import { ErrorState } from "../../components/states/ErrorState";
import { useNetwork } from "../../hooks/useNetwork";
import { useWallet } from "../../hooks/useWallet";

export default function ProfileScreen() {
  const router = useRouter();
  const { address, connected, connect, disconnect, error, refresh } = useWallet();
  const { networkLabel, contractId, rpcUrl } = useNetwork();

  if (error) {
    return <ErrorState message={error} onRetry={refresh} />;
  }

  return (
    <View style={styles.container}>
      {connected && address ? (
        <View style={styles.panel}>
          <Text style={styles.eyebrow}>Wallet profile</Text>
          <Text style={styles.title}>Connected wallet</Text>
          <Text style={styles.address}>
            {address.slice(0, 8)}…{address.slice(-6)}
          </Text>
          <Text style={styles.meta}>{networkLabel} active</Text>

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Contract ID</Text>
            <Text style={styles.detailValue}>{contractId}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>RPC URL</Text>
            <Text style={styles.detailValue}>{rpcUrl}</Text>
          </View>

          <TouchableOpacity
            style={styles.button}
            onPress={() => router.push("/settings" as Parameters<typeof router.push>[0])}
          >
            <Text style={styles.buttonText}>Open settings</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryButton} onPress={disconnect}>
            <Text style={styles.secondaryButtonText}>Disconnect</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <EmptyState
          icon="👤"
          title="Wallet disconnected"
          subtitle="Connect a wallet to view your profile and manage pool actions."
          actionLabel="Connect wallet"
          onAction={() => connect()}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f172a",
    padding: 24,
  },
  panel: {
    backgroundColor: "#111827",
    borderWidth: 1,
    borderColor: "#1f2937",
    borderRadius: 20,
    padding: 18,
    marginTop: 32,
  },
  eyebrow: {
    color: "#818cf8",
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: "800",
    color: "#f1f5f9",
    marginBottom: 10,
  },
  address: {
    fontSize: 15,
    color: "#e2e8f0",
    marginBottom: 8,
    fontFamily: "monospace",
    fontWeight: "700",
  },
  meta: {
    color: "#94a3b8",
    fontSize: 13,
    marginBottom: 16,
  },
  detailRow: {
    marginBottom: 12,
  },
  detailLabel: {
    color: "#94a3b8",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  detailValue: {
    color: "#e2e8f0",
    fontSize: 12,
    lineHeight: 18,
  },
  button: {
    backgroundColor: "#6366f1",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    marginTop: 8,
  },
  secondaryButton: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: "#334155",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  buttonText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 14,
  },
  secondaryButtonText: {
    color: "#e2e8f0",
    fontWeight: "600",
    fontSize: 14,
  },
});
