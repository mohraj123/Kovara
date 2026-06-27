import React from "react";
import { FlatList, StyleSheet, ActivityIndicator, RefreshControl, View } from "react-native";
import { useRouter } from "expo-router";
import { PostCard, Post } from "../../components/PostCard";
import { PostCardSkeleton } from "../../components/skeletons/PostCardSkeleton";
import { EmptyState } from "../../components/states/EmptyState";
import { ErrorState } from "../../components/states/ErrorState";
import { useFeed } from "../../hooks/useFeed";
import { useTheme } from "../../theme/useTheme";

const SKELETON_COUNT = 4;

function SkeletonList() {
  return (
    <>
      {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
        <PostCardSkeleton key={i} />
      ))}
    </>
  );
}

export default function FeedScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const { posts, loading, error, errorCode, loadMore, refresh } = useFeed();

  const isInitialLoad = loading && posts.length === 0;

  if (isInitialLoad) {
    return (
      <View style={styles.container}>
        <SkeletonList />
      </View>
    );
  }

  if (error && posts.length === 0) {
    return <ErrorState message={error} statusCode={errorCode} onRetry={refresh} />;
  }

  return (
    <FlatList<Post>
      style={styles.container}
      contentContainerStyle={posts.length === 0 ? styles.emptyContainer : styles.listContent}
      data={posts}
      keyExtractor={(item) => String(item.id)}
      renderItem={({ item }) => <PostCard post={item} />}
      ListEmptyComponent={
        <EmptyState
          icon="📭"
          title="No posts yet"
          subtitle="Be the first to post on Kovara."
          actionLabel="Explore creators"
          onAction={() => router.push("/(tabs)/explore" as Parameters<typeof router.push>[0])}
        />
      }
      ListFooterComponent={
        loading && posts.length > 0 ? (
          <ActivityIndicator
            style={styles.footer}
            color={theme.colors.brand.primary}
            size="small"
          />
        ) : null
      }
      onEndReached={loadMore}
      onEndReachedThreshold={0.4}
      refreshControl={
        <RefreshControl
          refreshing={loading && posts.length > 0}
          onRefresh={refresh}
          tintColor={theme.colors.brand.primary}
          colors={[theme.colors.brand.primary]}
        />
      }
    />
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f172a",
  },
  listContent: {
    paddingVertical: 8,
  },
  emptyContainer: {
    flex: 1,
  },
  center: {
    flex: 1,
    backgroundColor: "#0f172a",
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  footer: {
    paddingVertical: 16,
  },
});
