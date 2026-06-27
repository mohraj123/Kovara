import React, { useMemo } from "react";
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

type ProfileParams = {
  address: string;
};

export default function ProfileDetailScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { address } = useLocalSearchParams<ProfileParams>();
  const { address: me } = useWallet();

  const { profile, loading, error, errorCode, followerCount, followingCount, isFollowing, toggleFollow, refresh } =
    useProfile(address ?? "");

  const { posts, loading: postsLoading, refresh: refreshPosts } = useFeed();

  const userPosts = posts.filter((p) => p.author === address);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={theme.colors.brand.primary} />
      </View>
    );
  }

  if (error) {
    return <ErrorState message={error} statusCode={errorCode} onRetry={refresh} />;
  }

  return (
    <View style={styles.container}>
      {profile && (
        <ProfileHeader
          profile={profile}
          followerCount={followerCount}
          followingCount={followingCount}
          isFollowing={isFollowing}
          isOwnProfile={me === address}
          onFollowersPress={() => router.push(`/profile/followers?address=${address}` as Parameters<typeof router.push>[0])}
          onFollowingPress={() => router.push(`/profile/following?address=${address}` as Parameters<typeof router.push>[0])}
          onEditPress={() => router.push("/settings" as Parameters<typeof router.push>[0])}
          onToggleFollow={toggleFollow}
        />
      )}

      <FlatList
        data={userPosts}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => <PostCard post={item} />}
        onRefresh={() => {
          refreshPosts();
          refresh();
        }}
        refreshing={postsLoading}
        contentContainerStyle={styles.list}
        ListEmptyComponent={() => (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No posts yet</Text>
            <Text style={styles.emptyText}>This user hasn't posted anything.</Text>
          </View>
        )}
      />
    </View>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.surface.background,
    },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.surface.background,
    },
    list: {
      paddingBottom: 48,
      backgroundColor: theme.colors.surface.background,
    },
    empty: {
      padding: 24,
      alignItems: "center",
    },
    emptyTitle: {
      color: theme.colors.text.primary,
      fontSize: 16,
      fontWeight: "700",
    },
    emptyText: {
      color: theme.colors.text.secondary,
      marginTop: 8,
    },
  });
}
