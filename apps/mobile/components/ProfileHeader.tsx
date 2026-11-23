import React, { useMemo } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/useTheme";

export interface ProfileData {
  address: string;
  username?: string | null;
  bio?: string | null;
  bannerUrl?: string | null;
}

// Profile field constraints. Username limits mirror `MIN_USERNAME_LEN` /
// `MAX_USERNAME_LEN` in the contract and `validateUsername` in apps/web.
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
export const BANNER_URL_MAX_LENGTH = 2048;
const USERNAME_CHARS_RE = /^[a-zA-Z0-9_]+$/;
// React Native's URL polyfill doesn't implement `protocol`, so match the
// scheme and host shape directly: http(s), a dotted host or localhost, no
// credentials and no spaces.
const BANNER_URL_RE = /^https?:\/\/(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d{1,5})?(?:[/?#]\S*)?$/i;

export function validateUsername(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Username is required.";
  if (trimmed.length < USERNAME_MIN_LENGTH) {
    return `Username must be at least ${USERNAME_MIN_LENGTH} characters.`;
  }
  if (trimmed.length > USERNAME_MAX_LENGTH) {
    return `Username must be ${USERNAME_MAX_LENGTH} characters or fewer.`;
  }
  if (!USERNAME_CHARS_RE.test(trimmed)) {
    return "Username may only contain letters, numbers, and underscores.";
  }
  return null;
}

/** Banner URL is optional; an empty value is valid. */
export function validateBannerUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > BANNER_URL_MAX_LENGTH) {
    return `Banner URL must be ${BANNER_URL_MAX_LENGTH} characters or fewer.`;
  }
  if (!/^https?:\/\//i.test(trimmed)) return "Banner URL must start with http:// or https://.";
  if (!BANNER_URL_RE.test(trimmed)) return "Enter a valid banner URL.";
  return null;
}

export function isDisplayableBannerUrl(value: string | null | undefined): value is string {
  return !!value && !!value.trim() && validateBannerUrl(value) === null;
}

interface Props {
  profile: ProfileData;
  followerCount: number;
  followingCount: number;
  isFollowing: boolean;
  isOwnProfile?: boolean;
  onFollowersPress: () => void;
  onFollowingPress: () => void;
  onEditPress: () => void;
  onToggleFollow: () => void;
}

export default function ProfileHeader({
  profile,
  followerCount,
  followingCount,
  isFollowing,
  isOwnProfile,
  onFollowersPress,
  onFollowingPress,
  onEditPress,
  onToggleFollow,
}: Props) {
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const shortAddress = `${profile.address.slice(0, 8)}…${profile.address.slice(-6)}`;

  return (
    <View style={styles.container}>
      {isDisplayableBannerUrl(profile.bannerUrl) ? (
        <View style={styles.bannerWrap}>
          <Image testID="profile-banner-image" source={{ uri: profile.bannerUrl.trim() }} style={styles.bannerImage} />
        </View>
      ) : null}
      <View style={styles.row}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{(profile.username ?? "").charAt(0).toUpperCase() || "?"}</Text>
        </View>
        <View style={styles.meta}>
          <Text style={styles.username}>{profile.username ?? shortAddress}</Text>
          <Text style={styles.address}>{shortAddress}</Text>
          {profile.bio ? <Text style={styles.bio}>{profile.bio}</Text> : null}
        </View>
        <View style={styles.actionWrap}>
          {isOwnProfile ? (
            <Pressable style={styles.editButton} onPress={onEditPress} accessibilityRole="button">
              <Text style={styles.editText}>Edit</Text>
            </Pressable>
          ) : (
            <Pressable
              style={[styles.followButton, isFollowing ? styles.following : null]}
              onPress={onToggleFollow}
              accessibilityRole="button"
            >
              <Text style={[styles.followText, isFollowing ? styles.followingText : null]}>
                {isFollowing ? "Following" : "Follow"}
              </Text>
            </Pressable>
          )}
        </View>
      </View>

      <View style={styles.countsRow}>
        <Pressable onPress={onFollowersPress} accessibilityRole="button" style={styles.countItem}>
          <Text style={styles.countNumber}>{followerCount}</Text>
          <Text style={styles.countLabel}>Followers</Text>
        </Pressable>
        <Pressable onPress={onFollowingPress} accessibilityRole="button" style={styles.countItem}>
          <Text style={styles.countNumber}>{followingCount}</Text>
          <Text style={styles.countLabel}>Following</Text>
        </Pressable>
      </View>
    </View>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: {
      paddingHorizontal: 16,
      paddingVertical: 16,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.surface.border,
      backgroundColor: theme.colors.surface.background,
    },
    bannerWrap: {
      marginBottom: 12,
      borderRadius: 16,
      overflow: "hidden",
      height: 120,
      backgroundColor: theme.colors.surface.elevated,
    },
    bannerImage: {
      width: "100%",
      height: "100%",
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
    },
    avatar: {
      width: 72,
      height: 72,
      borderRadius: 36,
      backgroundColor: theme.colors.brand.primary,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 12,
    },
    avatarText: {
      color: theme.colors.text.onBrand,
      fontSize: 28,
      fontWeight: "800",
    },
    meta: {
      flex: 1,
    },
    username: {
      color: theme.colors.text.primary,
      fontSize: 18,
      fontWeight: "800",
    },
    address: {
      color: theme.colors.text.secondary,
      fontFamily: "monospace",
      marginTop: 2,
    },
    bio: {
      color: theme.colors.text.secondary,
      marginTop: 8,
    },
    actionWrap: {
      marginLeft: 8,
    },
    editButton: {
      backgroundColor: theme.colors.surface.elevated,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: theme.radius.full,
    },
    editText: {
      color: theme.colors.text.primary,
      fontWeight: "700",
    },
    followButton: {
      backgroundColor: theme.colors.brand.primary,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: theme.radius.full,
    },
    following: {
      backgroundColor: theme.colors.surface.elevated,
      borderWidth: 1,
      borderColor: theme.colors.surface.border,
    },
    followText: {
      color: theme.colors.text.onBrand,
      fontWeight: "700",
    },
    followingText: {
      color: theme.colors.text.primary,
    },
    countsRow: {
      flexDirection: "row",
      marginTop: 12,
      gap: 24,
    },
    countItem: {
      alignItems: "center",
    },
    countNumber: {
      color: theme.colors.text.primary,
      fontWeight: "800",
      fontSize: 15,
    },
    countLabel: {
      color: theme.colors.text.secondary,
      fontSize: 12,
      marginTop: 2,
    },
  });
}
