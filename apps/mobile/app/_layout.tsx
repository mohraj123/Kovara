import { Tabs, useRouter } from "expo-router";
import { useEffect } from "react";
import { Linking } from "react-native";

import { WalletProvider } from "../context/WalletContext";
import { parseDeepLink } from "../utils/deepLinks";

/**
 * Root layout — wraps the entire app in WalletProvider and sets up
 * the bottom tab navigator with deep-link handling.
 *
 * Screens:
 *   (tabs)/feed        — main post feed
 *   (tabs)/explore     — discovery / search
 *   (tabs)/pools       — community pools
 *   (tabs)/mini-apps   — mini app browser
 *   (tabs)/profile     — user profile
 *
 * Stack screens (detail views) are declared as modal/stack routes
 * alongside the tabs via the Tabs.Screen `href` opt-out pattern.
 */
export default function RootLayout() {
  const router = useRouter();

  useEffect(() => {
    let isMounted = true;

    async function handleInitialUrl() {
      let initialUrl: string | null = null;
      try {
        initialUrl = await Linking.getInitialURL();
      } catch {
        return;
      }
      if (isMounted && initialUrl) {
        handleDeepLink(initialUrl);
      }
    }

    function handleDeepLink(url: string) {
      const deepLink = parseDeepLink(url);
      if (!deepLink) return;
      router.push(deepLink.path as Parameters<typeof router.push>[0]);
    }

    const subscription = Linking.addEventListener("url", ({ url }) => {
      handleDeepLink(url);
    });

    handleInitialUrl();

    return () => {
      isMounted = false;
      subscription.remove();
    };
  }, [router]);

  return (
    <WalletProvider>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: "#6366f1",
          tabBarInactiveTintColor: "#9ca3af",
          tabBarStyle: {
            backgroundColor: "#0f172a",
            borderTopColor: "#1e293b",
          },
        }}
      >
        <Tabs.Screen
          name="(tabs)/feed"
          options={{ title: "Feed", tabBarLabel: "Feed" }}
        />
        <Tabs.Screen
          name="(tabs)/explore"
          options={{ title: "Explore", tabBarLabel: "Explore" }}
        />
        <Tabs.Screen
          name="(tabs)/pools"
          options={{ title: "Pools", tabBarLabel: "Pools" }}
        />
        <Tabs.Screen
          name="(tabs)/mini-apps"
          options={{ title: "Mini Apps", tabBarLabel: "Mini Apps" }}
        />
        <Tabs.Screen
          name="(tabs)/profile"
          options={{ title: "Profile", tabBarLabel: "Profile" }}
        />
        {/* Detail screens — hidden from tab bar */}
        <Tabs.Screen
          name="post/[id]"
          options={{ href: null, headerShown: true, title: "Post" }}
        />
        <Tabs.Screen
          name="profile/[address]"
          options={{ href: null, headerShown: true, title: "Profile" }}
        />
        <Tabs.Screen
          name="pool/[id]"
          options={{ href: null, headerShown: true, title: "Pool" }}
        />
      </Tabs>
    </WalletProvider>
  );
}
