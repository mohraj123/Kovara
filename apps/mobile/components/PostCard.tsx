import React, { useMemo, useState } from "react";
import {
  GestureResponderEvent,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useRouter } from "expo-router";

import { useLike } from "../hooks/useLike";
import { useTheme } from "../theme/useTheme";
import { PostCardSkeleton as SharedPostCardSkeleton } from "./skeletons/PostCardSkeleton";
import { TipModal } from "./TipModal";

export { SharedPostCardSkeleton as PostCardSkeleton };

export interface Post {
  id: number | string;
  author: string;
  username: string;
  content: string;
  tip_total: number;
  timestamp: number;
  like_count: number;
  has_liked?: boolean;
}

interface FeedPostCardProps {
  post: Post;
  onPress?: () => void;
}

interface LegacyPostCardProps {
  id: number | string;
  author: string;
  content: string;
  timestamp: string | number;
  likes?: number;
  hasLiked?: boolean;
  isLoading?: boolean;
  onPress?: () => void;
}

type PostCardProps = FeedPostCardProps | LegacyPostCardProps;

function formatTimestamp(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function normalizePost(props: PostCardProps): { post: Post; timeLabel?: string } {
  if ("post" in props) {
    return { post: props.post };
  }

  return {
    post: {
      id: props.id,
      author: props.author,
      username: props.author,
      content: props.content,
      tip_total: 0,
      timestamp: typeof props.timestamp === "number" ? props.timestamp : 0,
      like_count: props.likes ?? 0,
      has_liked: props.hasLiked ?? false,
    },
    timeLabel: typeof props.timestamp === "string" ? props.timestamp : undefined,
  };
}

export function PostCard(props: PostCardProps) {
  const { theme } = useTheme();
  const router = useRouter();
  const { post, timeLabel } = normalizePost(props);
  const [tipModalOpen, setTipModalOpen] = useState(false);
  const onPress =
    props.onPress ?? (() => router.push(`/post/${post.id}` as Parameters<typeof router.push>[0]));
  const { liked, likeCount, pending, like } = useLike({
    postId: post.id,
    initialHasLiked: post.has_liked ?? false,
    initialLikeCount: post.like_count,
  });

  const styles = useMemo(() => createStyles(theme), [theme]);

  if ("isLoading" in props && props.isLoading) {
    return <SharedPostCardSkeleton />;
  }

  const handleLikePress = (event: GestureResponderEvent) => {
    event.stopPropagation();
    void like();
  };

  const handleTipPress = (event: GestureResponderEvent) => {
    event.stopPropagation();
    setTipModalOpen(true);
  };

  const handleTipClose = () => setTipModalOpen(false);

  return (
    <View>
      <TouchableOpacity
        style={styles.card}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`Post by ${post.username}`}
        accessibilityHint="Opens post details"
      >
        <View style={styles.header}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{post.username.charAt(0).toUpperCase()}</Text>
          </View>
          <View style={styles.meta}>
            <Text style={styles.username}>{post.username}</Text>
            <Text style={styles.address}>{shortAddress(post.author)}</Text>
          </View>
          <Text style={styles.time}>{timeLabel ?? formatTimestamp(post.timestamp)}</Text>
        </View>

        <Text style={styles.content}>{post.content}</Text>

        <View style={styles.footer}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              liked ? `Unlike post. ${likeCount} likes` : `Like post. ${likeCount} likes`
            }
            accessibilityHint={liked ? "You have already liked this post" : "Tap to like this post"}
            accessibilityState={{ disabled: liked || pending, selected: liked, busy: pending }}
            disabled={liked || pending}
            onPress={handleLikePress}
            style={({ pressed }) => [
              styles.likeButton,
              liked && styles.likeButtonLiked,
              pressed && !liked && !pending && styles.likeButtonPressed,
            ]}
          >
            <Text style={[styles.stat, liked && styles.statLiked]}>
              {liked ? "Liked" : "Like"} {likeCount}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Send tip to ${post.username}. Currently ${post.tip_total} tips`}
            accessibilityHint="Opens the tip sheet"
            onPress={handleTipPress}
            style={({ pressed }) => [styles.tipButton, pressed && styles.tipButtonPressed]}
          >
            <Text style={styles.stat}>Tips {post.tip_total}</Text>
          </Pressable>
        </View>
      </TouchableOpacity>

      <TipModal
        visible={tipModalOpen}
        postId={post.id}
        authorName={post.username}
        onClose={handleTipClose}
      />
    </View>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    card: {
      backgroundColor: theme.colors.surface.surface1,
      borderRadius: 12,
      padding: 16,
      marginHorizontal: 16,
      marginVertical: 6,
      borderWidth: 1,
      borderColor: theme.colors.surface.border,
    },
    skeleton: {
      opacity: 0.8,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      marginBottom: 10,
    },
    avatar: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: theme.colors.brand.primary,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 10,
    },
    avatarText: {
      color: theme.colors.text.onBrand,
      fontWeight: "700",
      fontSize: 16,
    },
    meta: {
      flex: 1,
    },
    username: {
      color: theme.colors.text.primary,
      fontWeight: "600",
      fontSize: 14,
    },
    address: {
      color: theme.colors.text.secondary,
      fontSize: 11,
      fontFamily: "monospace",
    },
    time: {
      color: theme.colors.text.secondary,
      fontSize: 11,
    },
    content: {
      color: theme.colors.text.primary,
      fontSize: 14,
      lineHeight: 20,
    },
    footer: {
      flexDirection: "row",
      alignItems: "center",
      marginTop: 12,
      gap: 16,
    },
    likeButton: {
      minHeight: 32,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.colors.surface.border,
      paddingHorizontal: 12,
      alignItems: "center",
      justifyContent: "center",
    },
    likeButtonLiked: {
      borderColor: theme.colors.brand.primary,
      backgroundColor: theme.colors.brand.primaryLight,
    },
    likeButtonPressed: {
      opacity: 0.82,
    },
    tipButton: {
      minHeight: 32,
      borderRadius: 999,
      paddingHorizontal: 12,
      alignItems: "center",
      justifyContent: "center",
    },
    tipButtonPressed: {
      opacity: 0.82,
    },
    stat: {
      color: theme.colors.text.secondary,
      fontSize: 12,
      fontWeight: "700",
    },
    statLiked: {
      color: theme.colors.brand.primary,
    },
    skeletonBlock: {
      backgroundColor: theme.colors.surface.surface2,
    },
    skeletonLine: {
      height: 12,
      borderRadius: 6,
      backgroundColor: theme.colors.surface.surface2,
    },
  });
}
