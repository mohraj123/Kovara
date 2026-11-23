import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { useTheme } from "../theme/useTheme";

interface SearchBarProps {
  value: string;
  onChangeText: (value: string) => void;
  onClear?: () => void;
  placeholder?: string;
}

export function SearchBar({
  value,
  onChangeText,
  onClear,
  placeholder = "Search profiles and pools",
}: SearchBarProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const handleClear = () => {
    onChangeText("");
    onClear?.();
  };

  return (
    <View style={styles.container}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.text.secondary}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={styles.input}
        accessibilityLabel="Search profiles and pools"
      />
      {value.length > 0 ? (
        <Pressable
          onPress={handleClear}
          style={styles.clearButton}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
        >
          <Text style={styles.clearIcon}>✕</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: {
      marginHorizontal: 16,
      marginTop: 16,
      marginBottom: 8,
      position: "relative",
    },
    input: {
      minHeight: 48,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingRight: 44,
      backgroundColor: theme.colors.surface.surface1,
      borderWidth: 1,
      borderColor: theme.colors.surface.border,
      color: theme.colors.text.primary,
      fontSize: 15,
    },
    clearButton: {
      position: "absolute",
      right: 8,
      top: 0,
      bottom: 0,
      width: 36,
      alignItems: "center",
      justifyContent: "center",
    },
    clearIcon: {
      color: theme.colors.text.secondary,
      fontSize: 16,
    },
  });
}
