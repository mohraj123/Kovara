import React, { useMemo } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { UserListItem, UserListItemSkeleton } from "../../components/UserListItem";
import { useFollowing } from "../../hooks/useFollowing";
import { useTheme } from "../../theme/useTheme";
import type { FollowUser } from "../../hooks/useFollowers";

type FollowingParams = {
  address: string;
};
      // onPress={() => router.push("/connect" as Parameters<typeof router.push>[0])}

export default function FollowingScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { address } = useLocalSearchParams<FollowingParams>();
  const { users, loading, error, hasMore, loadMore, refresh } = useFollowing(address ?? "");

  const handleUserPress = useMemo(
    () => (user: FollowUser) => {
      router.push(`/profile/${user.address}` as Parameters<typeof router.push>[0]);
    },
    [router],
  );

  if (loading && users.length === 0) {
    return (
      <View
        style={styles.loading}
        accessibilityRole="progressbar"
        accessibilityLabel="Loading following"
      >
        {Array.from({ length: 8 }, (_, i) => (
          <UserListItemSkeleton key={i} />
        ))}
      </View>
    );
  }

  if (error && users.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable
          style={styles.retryButton}
          onPress={refresh}
          accessibilityRole="button"
          accessibilityLabel="Retry loading following"
        >
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (users.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyTitle}>Not following anyone</Text>
        <Text style={styles.emptyText}>This user is not following anyone yet.</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={users}
      keyExtractor={(item) => item.address}
      renderItem={({ item }) => (
        <UserListItem user={item} onPress={handleUserPress} />
      )}
      onEndReached={loadMore}
      onEndReachedThreshold={0.5}
      onRefresh={refresh}
      refreshing={loading}
      ListFooterComponent={
        error ? (
          <Pressable
            style={styles.footerError}
            onPress={loadMore}
            accessibilityRole="button"
            accessibilityLabel="Retry loading more following"
          >
            <Text style={styles.errorText}>{error}</Text>
            <Text style={styles.retryLink}>Tap to retry</Text>
          </Pressable>
        ) : hasMore && loading ? (
          <ActivityIndicator
            size="small"
            color={theme.colors.brand.primary}
            style={styles.footer}
          />
        ) : null
      }
      contentContainerStyle={styles.list}
    />
  );
}

function createStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    list: {
      backgroundColor: theme.colors.surface.background,
    },
    centered: {
      flex: 1,
      backgroundColor: theme.colors.surface.background,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 24,
      gap: 12,
    },
    errorText: {
      color: theme.colors.semantic.error,
      fontSize: 14,
      textAlign: "center",
    },
    retryButton: {
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.brand.primary,
      paddingHorizontal: 20,
      paddingVertical: 10,
    },
    retryText: {
      color: theme.colors.text.onBrand,
      fontSize: 14,
      fontWeight: "700",
    },
    emptyTitle: {
      color: theme.colors.text.primary,
      fontSize: 18,
      fontWeight: "700",
    },
    emptyText: {
      color: theme.colors.text.secondary,
      fontSize: 14,
      textAlign: "center",
    },
    loading: {
      flex: 1,
      backgroundColor: theme.colors.surface.background,
    },
    footer: {
      paddingVertical: 16,
    },
    footerError: {
      alignItems: "center",
      paddingHorizontal: 24,
      paddingVertical: 16,
      gap: 4,
    },
    retryLink: {
      color: theme.colors.brand.primary,
      fontSize: 14,
      fontWeight: "700",
    },
  });
}
