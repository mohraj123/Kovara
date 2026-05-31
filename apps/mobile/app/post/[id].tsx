import React from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import { useLocalSearchParams } from "expo-router";

type PostParams = {
  id: string;
};

export default function PostDetailScreen() {
  const { id } = useLocalSearchParams<PostParams>();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.label}>Post</Text>
      <Text style={styles.id}>#{id}</Text>
      <Text style={styles.placeholder}>Post detail coming soon.</Text>
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
  id: {
    fontSize: 20,
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
