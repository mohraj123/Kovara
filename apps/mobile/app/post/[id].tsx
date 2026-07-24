// Post detail screen — shows full content, like count, tip total, author info.
import React, { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { useDeletePost } from "../../hooks/useDeletePost";
import { useWallet } from "../../hooks/useWallet";
import { useTheme } from "../../theme/useTheme";
import { getPostById } from "../../utils/indexerClient";
import type { Post } from "../../components/PostCard";
import { IndexerError } from "../../../packages/sdk/src/errors";
import { EmptyState } from "../../components/states/EmptyState";
import { ErrorState } from "../../components/states/ErrorState";
import type { IndexerErrorCode } from "../../components/states/ErrorState";

// Status codes renderable by ErrorState; anything else (e.g. 0 from
// misconfiguration) collapses to 500 so the cast stays type-safe.
const RENDERABLE_ERROR_CODES: ReadonlySet<IndexerErrorCode> = new Set([
  400, 401, 403, 404, 429, 500, 502, 503, 504,
]);
function clampStatusCode(raw: number | undefined): IndexerErrorCode {
  if (typeof raw === "number" && RENDERABLE_ERROR_CODES.has(raw as IndexerErrorCode)) {
    return raw as IndexerErrorCode;
  }
  return 500;
}

type PostParams = {
  id: string;
};

export default function PostDetailScreen() {
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { id } = useLocalSearchParams<PostParams>();
  const router = useRouter();
  const { address } = useWallet();
  const { deleting, deletePost } = useDeletePost();
  const [post, setPost] = useState<Post | null | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<IndexerErrorCode | undefined>(undefined);

  const refresh = useMemo(
    () => async () => {
      if (!id) return;
      setErrorMessage(null);
      setErrorCode(undefined);
      try {
        const fetched = await getPostById(String(id));
        setPost(fetched);
      } catch (err) {
        if (err instanceof IndexerError) {
          setErrorCode(clampStatusCode(err.statusCode));
          setErrorMessage(err.message);
        } else {
          setErrorMessage("Could not load this post. Please try again.");
        }
        setPost(null);
      }
    },
    [id]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const isAuthor = Boolean(post && address && address === post.author);

  const handleDeletePress = () => {
    if (!post) {
      return;
    }

    Alert.alert("Delete post?", "This action cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const deleted = await deletePost({ postId: post.id, author: post.author });
          if (deleted) {
            router.replace("/(tabs)/feed" as Parameters<typeof router.replace>[0]);
          }
        },
      },
    ]);
  };

  if (post === undefined) {
    // Still fetching from the indexer; show a brief placeholder.
    return (
      <View style={[styles.container, styles.content]}>
        <Text style={styles.label}>Post</Text>
        <Text style={styles.id}>#{id}</Text>
        <Text style={styles.placeholder}>Loading…</Text>
      </View>
    );
  }

  if (errorMessage && !post) {
    return (
      <View style={[styles.container, styles.content]}>
        <ErrorState message={errorMessage} statusCode={errorCode} onRetry={() => void refresh()} />
      </View>
    );
  }

  if (!post) {
    return (
      <View style={[styles.container, styles.content]}>
        <Text style={styles.label}>Post</Text>
        <Text style={styles.id}>#{id}</Text>
        <EmptyState
          icon="🔍"
          title="Post not found"
          subtitle="This post may have been deleted by its author."
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, styles.content]}>
      <Text style={styles.label}>Post</Text>
      <Text style={styles.id}>#{post.id}</Text>
      <View style={styles.card}>
        <View style={styles.header}>
          <Text style={styles.username}>{post.username}</Text>
          <Text style={styles.author}>{post.author}</Text>
        </View>
        <Text style={styles.contentText}>{post.content}</Text>
        <Text style={styles.stats}>
          Likes {post.like_count} | Tips {post.tip_total}
        </Text>
      </View>

      {isAuthor ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Delete post"
          disabled={deleting}
          onPress={handleDeletePress}
          style={({ pressed }) => [
            styles.deleteButton,
            deleting && styles.deleteButtonDisabled,
            pressed && !deleting && styles.deleteButtonPressed,
          ]}
        >
          <Text style={styles.deleteButtonText}>{deleting ? "Deleting..." : "Delete post"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.surface.background,
    },
    content: {
      padding: 24,
    },
    label: {
      fontSize: 12,
      color: theme.colors.text.secondary,
      textTransform: "uppercase",
      letterSpacing: 1,
      marginBottom: 4,
    },
    id: {
      fontSize: 20,
      fontWeight: "700",
      color: theme.colors.text.primary,
      marginBottom: 16,
      fontFamily: "monospace",
    },
    placeholder: {
      fontSize: 14,
      color: theme.colors.text.secondary,
    },
    card: {
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.colors.surface.border,
      backgroundColor: theme.colors.surface.surface1,
      padding: 16,
      marginBottom: 20,
    },
    header: {
      marginBottom: 12,
    },
    username: {
      color: theme.colors.text.primary,
      fontSize: 16,
      fontWeight: "700",
      marginBottom: 4,
    },
    author: {
      color: theme.colors.text.secondary,
      fontFamily: "monospace",
      fontSize: 11,
    },
    contentText: {
      color: theme.colors.text.primary,
      fontSize: 15,
      lineHeight: 22,
      marginBottom: 16,
    },
    stats: {
      color: theme.colors.text.secondary,
      fontSize: 13,
    },
    deleteButton: {
      minHeight: 46,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.semantic.error,
      paddingHorizontal: 18,
    },
    deleteButtonPressed: {
      opacity: 0.88,
    },
    deleteButtonDisabled: {
      opacity: 0.56,
    },
    deleteButtonText: {
      color: theme.colors.text.onBrand,
      fontSize: 14,
      fontWeight: "800",
    },
  });
}
