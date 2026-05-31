import React from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import { useLocalSearchParams } from "expo-router";

type ProfileParams = {
  address: string;
};

export default function ProfileDetailScreen() {
  const { address } = useLocalSearchParams<ProfileParams>();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.label}>Profile</Text>
      <Text style={styles.address}>
        {address ? `${address.slice(0, 8)}…${address.slice(-6)}` : "—"}
      </Text>
      <Text style={styles.placeholder}>Profile detail coming soon.</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f172a",
  },
  content: {
    padding: 24,
  },
  label: {
    fontSize: 12,
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 4,
  },
  address: {
    fontSize: 16,
    fontWeight: "700",
    color: "#f1f5f9",
    marginBottom: 16,
    fontFamily: "monospace",
  },
  placeholder: {
    fontSize: 14,
    color: "#94a3b8",
  },
});
