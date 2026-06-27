import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { WalletButton } from "../components/WalletButton";
import { useWallet } from "../hooks/useWallet";
import type { WalletProviderKind } from "../context/WalletContext";
import { useTheme } from "../theme/useTheme";

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

export default function ConnectScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { address, connected, disconnect, connect, error, state, wallet, availability } =
    useWallet();

  const handleConnect = async (provider: WalletProviderKind) => {
    await connect(provider);
  };

  const handleDisconnect = async () => {
    await disconnect();
  };

  const providerLabel = wallet.provider === "freighter" ? "Freighter" : "WalletConnect";
  const hasAnyWallet = availability.freighter || availability.walletconnect;

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.eyebrow}>Kovara Wallet</Text>
        <Text style={styles.title}>Connect your Stellar wallet</Text>
        <Text style={styles.subtitle}>
          Use Freighter in browser contexts or WalletConnect for mobile wallets.
        </Text>

        {connected && address ? (
          <View
            style={styles.connectedPanel}
            accessibilityRole="summary"
            accessibilityLabel={`Wallet connected. Address ${shortAddress(address)}. Provider ${providerLabel}.`}
          >
            <Text style={styles.panelLabel}>Connected address</Text>
            <Text
              style={styles.address}
              accessibilityLabel={`Wallet address ${shortAddress(address)}`}
            >
              {shortAddress(address)}
            </Text>
            <Text
              style={styles.provider}
              accessibilityLabel={`Active wallet provider ${providerLabel}`}
            >
              {providerLabel}
            </Text>
            <WalletButton
              label="Continue"
              accessibilityLabel="Continue to feed"
              accessibilityHint="Closes the connect screen and opens the main feed"
              onPress={() => router.replace("/(tabs)/feed")}
              state={state}
              style={styles.action}
            />
            <WalletButton
              label="Disconnect"
              accessibilityLabel="Disconnect wallet"
              accessibilityHint="Disconnects your wallet and returns to wallet picker"
              onPress={handleDisconnect}
              state={state}
              variant="danger"
            />
          </View>
        ) : (
          <View style={styles.buttonStack} accessibilityRole="none">
            <WalletButton
              label="Connect Freighter"
              accessibilityLabel="Connect with Freighter wallet"
              accessibilityHint="Pairs with the Freighter browser extension"
              onPress={() => handleConnect("freighter")}
              provider="freighter"
              state={state}
            />
            <WalletButton
              label="Connect WalletConnect"
              accessibilityLabel="Connect with WalletConnect wallet"
              accessibilityHint="Opens a QR code to pair with a mobile Stellar wallet"
              onPress={() => handleConnect("walletconnect")}
              provider="walletconnect"
              state={state}
              variant="secondary"
            />
          <View style={styles.buttonStack}>
            {availability.freighter ? (
              <WalletButton
                label="Connect Freighter"
                accessibilityLabel="Connect with Freighter wallet"
                onPress={() => handleConnect("freighter")}
                provider="freighter"
                state={state}
              />
            ) : (
              <View style={styles.unavailableRow}>
                <Text style={styles.unavailableText}>
                  ⚠️ Freighter is not detected — install it for the best desktop experience.
                </Text>
              </View>
            )}

            {availability.walletconnect ? (
              <WalletButton
                label="Connect WalletConnect"
                accessibilityLabel="Connect with WalletConnect wallet"
                onPress={() => handleConnect("walletconnect")}
                provider="walletconnect"
                state={state}
                variant="secondary"
              />
            ) : (
              <View style={styles.unavailableRow}>
                <Text style={styles.unavailableText}>
                  ⚠️ WalletConnect is not available — check your project configuration.
                </Text>
              </View>
            )}

            {!hasAnyWallet && state !== "connecting" && (
              <View style={styles.guidanceBox} accessibilityRole="alert">
                <Text style={styles.guidanceTitle}>No wallet detected</Text>
                <Text style={styles.guidanceText}>
                  To get started, install a Stellar wallet:
                </Text>
                <Text style={styles.guidanceBullet}>
                  • Freighter browser extension (desktop)
                </Text>
                <Text style={styles.guidanceBullet}>
                  • Any WalletConnect-compatible mobile wallet
                </Text>
              </View>
            )}
          </View>
        )}

        {error ? (
          <View
            style={styles.errorBox}
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
            accessibilityLabel={`Wallet error. ${error}`}
          >
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}
      </View>
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
      flex: 1,
      padding: 24,
      justifyContent: "center",
    },
    eyebrow: {
      color: theme.colors.brand.secondary,
      fontSize: 12,
      fontWeight: "700",
      marginBottom: 8,
      textTransform: "uppercase",
    },
    title: {
      color: theme.colors.text.primary,
      fontSize: 30,
      fontWeight: "800",
      marginBottom: 10,
    },
    subtitle: {
      color: theme.colors.text.secondary,
      fontSize: 15,
      lineHeight: 22,
      marginBottom: 28,
    },
    buttonStack: {
      gap: 12,
    },
    connectedPanel: {
      backgroundColor: theme.colors.surface.surface1,
      borderColor: theme.colors.surface.border,
      borderWidth: 1,
      borderRadius: 12,
      padding: 16,
    },
    panelLabel: {
      color: theme.colors.text.secondary,
      fontSize: 12,
      marginBottom: 6,
    },
    address: {
      color: theme.colors.text.primary,
      fontFamily: "monospace",
      fontSize: 16,
      fontWeight: "700",
    },
    provider: {
      color: theme.colors.text.secondary,
      fontSize: 13,
      marginTop: 6,
      marginBottom: 16,
    },
    action: {
      marginBottom: 10,
    },
    errorBox: {
      backgroundColor: theme.colors.semantic.errorLight,
      borderColor: theme.colors.semantic.error,
      borderWidth: 1,
      borderRadius: 10,
      padding: 12,
      marginTop: 16,
    },
    errorText: {
      color: theme.colors.semantic.error,
      fontSize: 13,
    },
    unavailableRow: {
      backgroundColor: theme.colors.surface.surface1,
      borderColor: theme.colors.surface.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: 10,
      opacity: 0.8,
    },
    unavailableText: {
      color: theme.colors.text.secondary,
      fontSize: 12,
      fontStyle: "italic",
    },
    guidanceBox: {
      marginTop: 16,
      backgroundColor: theme.colors.surface.surface1,
      borderColor: theme.colors.brand.secondary,
      borderWidth: 1,
      borderRadius: 12,
      padding: 16,
    },
    guidanceTitle: {
      color: theme.colors.text.primary,
      fontSize: 15,
      fontWeight: "700",
      marginBottom: 8,
    },
    guidanceText: {
      color: theme.colors.text.secondary,
      fontSize: 13,
      lineHeight: 20,
      marginBottom: 8,
    },
    guidanceBullet: {
      color: theme.colors.text.secondary,
      fontSize: 13,
      lineHeight: 22,
      paddingLeft: 4,
    },
  });
}
