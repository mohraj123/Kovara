import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../../theme/useTheme";

/** Subset of HTTP-like status codes the indexer may return. */
export type IndexerErrorCode = 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503 | 504;

function resolveTitle(statusCode?: IndexerErrorCode): string {
  if (!statusCode) return "Something went wrong";
  if (statusCode === 404) return "Not found";
  if (statusCode === 429) return "Too many requests";
  if (statusCode === 401 || statusCode === 403) return "Access denied";
  if (statusCode >= 500) return "Service unavailable";
  return "Something went wrong";
}

function resolveMessage(statusCode?: IndexerErrorCode, fallback?: string): string {
  if (!statusCode) return fallback ?? "An unexpected error occurred. Please try again.";
  if (statusCode === 404) return fallback ?? "The requested data could not be found.";
  if (statusCode === 429)
    return fallback ?? "The indexer is receiving too many requests. Please wait a moment.";
  if (statusCode === 401 || statusCode === 403)
    return fallback ?? "You don't have permission to access this data.";
  if (statusCode === 502 || statusCode === 504)
    return fallback ?? "The indexer is temporarily unreachable. Please try again shortly.";
  if (statusCode === 503)
    return fallback ?? "The indexer is currently unavailable. Please check back soon.";
  if (statusCode >= 500)
    return fallback ?? "The indexer returned an error. Please try again in a moment.";
  return fallback ?? "An unexpected error occurred. Please try again.";
}

export interface ErrorStateProps {
  message?: string;
  onRetry: () => void;
  retryLabel?: string;
  title?: string;
  /** Optional HTTP-like status code from the indexer for contextual messaging. */
  statusCode?: IndexerErrorCode;
  testID?: string;
}

export function ErrorState({
  message,
  onRetry,
  retryLabel = "Try again",
  title,
  statusCode,
  testID = "error-state",
}: ErrorStateProps): JSX.Element {
  const { theme } = useTheme();

  const resolvedTitle = title ?? resolveTitle(statusCode);
  const resolvedMessage = resolveMessage(statusCode, message);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: 28,
          paddingVertical: 48,
          backgroundColor: theme.colors.surface.background,
        },
        iconContainer: {
          width: 72,
          height: 72,
          borderRadius: 22,
          backgroundColor: theme.colors.surface.surface1,
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 20,
          borderWidth: 1,
          borderColor: theme.colors.semantic.error,
        },
        iconText: {
          color: theme.colors.semantic.error,
          fontSize: 30,
          fontWeight: "900",
        },
        title: {
          color: theme.colors.text.primary,
          fontSize: 22,
          fontWeight: "800",
          textAlign: "center",
          marginBottom: 8,
        },
        message: {
          color: theme.colors.text.secondary,
          fontSize: 14,
          lineHeight: 21,
          textAlign: "center",
          marginBottom: 22,
        },
        statusBadge: {
          marginBottom: 16,
          paddingHorizontal: 10,
          paddingVertical: 3,
          borderRadius: 6,
          backgroundColor: theme.colors.surface.surface2,
          borderWidth: 1,
          borderColor: theme.colors.surface.border,
        },
        statusBadgeText: {
          color: theme.colors.text.secondary,
          fontSize: 11,
          fontWeight: "700",
          letterSpacing: 0.4,
        },
        actionButton: {
          minHeight: 44,
          paddingHorizontal: 18,
          borderRadius: theme.radius.full,
          backgroundColor: theme.colors.brand.primary,
          alignItems: "center",
          justifyContent: "center",
        },
        actionButtonPressed: {
          opacity: 0.88,
          transform: [{ scale: 0.98 }],
        },
        actionLabel: {
          color: theme.colors.text.onBrand,
          fontSize: 14,
          fontWeight: "700",
        },
      }),
    [theme]
  );

  return (
    <View
      style={styles.container}
      testID={testID}
      accessibilityRole="alert"
      accessibilityLabel={`${resolvedTitle}. ${resolvedMessage}`}
    >
      <View style={styles.iconContainer}>
        <Text style={styles.iconText}>!</Text>
      </View>
      {statusCode ? (
        <View style={styles.statusBadge}>
          <Text style={styles.statusBadgeText}>Error {statusCode}</Text>
        </View>
      ) : null}
      <Text style={styles.title}>{resolvedTitle}</Text>
      <Text style={styles.message}>{resolvedMessage}</Text>
      <Pressable
        style={({ pressed }) => [styles.actionButton, pressed && styles.actionButtonPressed]}
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel={retryLabel}
        testID={`${testID}-retry`}
      >
        <Text style={styles.actionLabel}>{retryLabel}</Text>
      </Pressable>
    </View>
  );
}
