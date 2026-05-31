import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { useWallet } from "../../hooks/useWallet";

export default function ProfileScreen() {
  const { address, connected, connect, disconnect } = useWallet();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Profile</Text>

      {connected && address ? (
        <>
          <Text style={styles.address}>
            {address.slice(0, 6)}…{address.slice(-4)}
          </Text>
          <TouchableOpacity style={styles.button} onPress={disconnect}>
            <Text style={styles.buttonText}>Disconnect</Text>
          </TouchableOpacity>
        </>
      ) : (
        <TouchableOpacity style={styles.button} onPress={connect}>
          <Text style={styles.buttonText}>Connect Wallet</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f172a",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: "#f1f5f9",
    marginBottom: 16,
  },
  address: {
    fontSize: 14,
    color: "#94a3b8",
    marginBottom: 16,
    fontFamily: "monospace",
  },
  button: {
    backgroundColor: "#6366f1",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  buttonText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 14,
  },
});
