import React from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
} from "react-native";
import { useRouter } from "expo-router";
import { PoolCard } from "../../components/PoolCard";
import { usePools } from "../../hooks/usePools";
import { EmptyState } from "../../components/states/EmptyState";
import { ErrorState } from "../../components/states/ErrorState";
import { useTheme } from "../../theme/useTheme";

export default function PoolsScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const { pools, loading, error, errorCode, refresh } = usePools();

  const handlePoolPress = (poolId: string) => {
    router.push(`/pool/${poolId}`);
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Pools</Text>
          <Text style={styles.subtitle}>Community funding pools</Text>
        </View>
        <View style={styles.loaderContainer}>
          <ActivityIndicator size="large" color={theme.colors.brand.primary} />
        </View>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Pools</Text>
          <Text style={styles.subtitle}>Community funding pools</Text>
        </View>
        <ErrorState message={error} statusCode={errorCode} onRetry={refresh} />
      </View>
    );
  }

  if (pools.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Pools</Text>
          <Text style={styles.subtitle}>Community funding pools</Text>
        </View>
        <EmptyState
          icon="◎"
          title="No pools available"
          subtitle="Check back soon for community funding opportunities"
        />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <View style={styles.header}>
        <Text style={styles.title}>Pools</Text>
        <Text style={styles.subtitle}>Community funding pools</Text>
      </View>

      <View style={styles.listContainer}>
        {pools.map((pool) => (
          <TouchableOpacity
            key={pool.pool_id}
            onPress={() => handlePoolPress(pool.pool_id)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={`Pool ${pool.pool_id}`}
          >
            <PoolCard
              id={pool.pool_id}
              name={pool.token}
              description={`${pool.admins.length} admin${pool.admins.length === 1 ? "" : "s"}`}
              totalValue={`${pool.balance.toString()}`}
              participants={pool.admins.length}
              onPress={() => handlePoolPress(pool.pool_id)}
            />
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f172a",
  },
  contentContainer: {
    paddingBottom: 24,
  },
  header: {
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 16,
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
  listContainer: {
    paddingHorizontal: 16,
    gap: 8,
  },
  loaderContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
