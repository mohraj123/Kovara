import React from "react";
import { View, Text, StyleSheet } from "react-native";

export default function PoolsScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Pools</Text>
      <Text style={styles.subtitle}>Community funding pools</Text>
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
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: "#94a3b8",
  },
});
