import React, { useMemo } from "react";
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import ProfileHeader from "../../components/ProfileHeader";
import { PostCard } from "../../components/PostCard";
import { ErrorState } from "../../components/states/ErrorState";
import { useFeed } from "../../hooks/useFeed";
import { useProfile } from "../../hooks/useProfile";
import { useWallet } from "../../hooks/useWallet";
import { useTheme } from "../../theme/useTheme";

type ProfileParams = {
  address: string | string[];
};

export default function ProfileDetailScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const params = useLocalSearchParams<ProfileParams>();
  const address = (Array.isArray(params.address) ? params.address[0] : params.address) ?? "";
  const { address: me } = useWallet();

  // useProfile discards responses for any address other than the current one,
  // so navigating between profiles never flashes the previous user's data.
  const { profile, loading, error, errorCode, followerCount, followingCount, isFollowing, toggleFollow, refresh } =
    useProfile(address);

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
      {profile && profile.address === address && (
        <ProfileHeader
          profile={profile}
          followerCount={followerCount}
          followingCount={followingCount}
          isFollowing={isFollowing}
          isOwnProfile={me === address}
          onFollowersPress={() => router.push(`/profile/followers?address=${address}` as Parameters<typeof router.push>[0])}
          onFollowingPress={() => router.push(`/profile/following?address=${address}` as Parameters<typeof router.push>[0])}
          onEditPress={() => router.push("/profile/edit" as Parameters<typeof router.push>[0])}
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
