import React from "react";
import { render, act, waitFor, fireEvent } from "@testing-library/react-native";
import { Text, TouchableOpacity, View } from "react-native";
import { WalletProvider, useWallet } from "../hooks/useWallet";
import * as secureStorage from "../utils/secureStorage";

// Mock NetworkContext so WalletProvider doesn't require NetworkProvider
jest.mock("../context/NetworkContext", () => ({
  useNetworkContext: () => ({
    network: { label: "Testnet", rpcUrl: "https://soroban-testnet.stellar.org", contractId: "" },
    networkLabel: "Testnet",
    contractId: "",
    rpcUrl: "https://soroban-testnet.stellar.org",
    isMainnet: false,
    setNetwork: jest.fn(),
  }),
  NetworkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock expo-secure-store
jest.mock("expo-secure-store", () => {
  let store: Record<string, string> = {};
  return {
    ALWAYS_THIS_DEVICE_ONLY: "ALWAYS_THIS_DEVICE_ONLY",
    setItemAsync: async (key: string, value: string) => {
      store[key] = value;
      return Promise.resolve();
    },
    getItemAsync: async (key: string) => {
      return Promise.resolve(store[key] ?? null);
    },
    deleteItemAsync: async (key: string) => {
      delete store[key];
      return Promise.resolve();
    },
    // Helper to reset store between tests
    __resetStore: () => {
      store = {};
    },
  };
});

// Mock Stellar Wallet Kit
const mockWalletKit = {
  connect: jest.fn(),
  disconnect: jest.fn(),
  getPublicKey: jest.fn(),
  isConnected: jest.fn(),
  onAccountChange: jest.fn(),
  onNetworkChange: jest.fn(),
};

jest.mock(
  "@stellar/wallet-kit",
  () => ({
    WalletKit: jest.fn().mockImplementation(() => mockWalletKit),
    NETWORK: {
      TESTNET: "TESTNET",
      MAINNET: "MAINNET",
    },
  }),
  { virtual: true }
);

// Test component to access wallet context
const TestComponent: React.FC = () => {
  const { state, wallet, connect, disconnect, error } = useWallet();

  return (
    <View>
      <Text testID="wallet-state">{state}</Text>
      <Text testID="wallet-address">{wallet.address || "null"}</Text>
      <Text testID="wallet-error">{error || "null"}</Text>
      <TouchableOpacity testID="connect-btn" onPress={() => connect()}>
        <Text>Connect</Text>
      </TouchableOpacity>
      <TouchableOpacity testID="disconnect-btn" onPress={disconnect}>
        <Text>Disconnect</Text>
      </TouchableOpacity>
    </View>
  );
};

const TestApp: React.FC = () => (
  <WalletProvider>
    <TestComponent />
  </WalletProvider>
);

describe("Wallet Connect Integration Tests", () => {
  const mockAddress = "GCKFBEIYTKP6RCZNVPH73XL7XFWTEOAO4MKONX7HOILHDVBMW5EVPOPZ";
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mockSecureStore = require("expo-secure-store");

  beforeEach(() => {
    jest.clearAllMocks();
    mockSecureStore.__resetStore();
    globalThis.__LINKORA_WALLET_KIT__ = mockWalletKit;

    // Reset wallet kit mocks
    mockWalletKit.connect.mockReset();
    mockWalletKit.disconnect.mockReset();
    mockWalletKit.getPublicKey.mockReset();
    mockWalletKit.isConnected.mockReset();
  });

  afterEach(() => {
    delete globalThis.__LINKORA_WALLET_KIT__;
  });

  describe("Connect Flow", () => {
    it("should connect wallet and store address in context", async () => {
      // Setup successful connection
      mockWalletKit.connect.mockResolvedValue({ publicKey: mockAddress });
      mockWalletKit.getPublicKey.mockResolvedValue(mockAddress);
      mockWalletKit.isConnected.mockResolvedValue(true);

      const { getByTestId } = render(<TestApp />);

      // Initial state should be loading
      expect(getByTestId("wallet-state").children[0]).toBe("loading");
      expect(getByTestId("wallet-address").children[0]).toBe("null");

      await waitFor(() => {
        expect(getByTestId("wallet-state").children[0]).toBe("disconnected");
      });

      // Trigger connect
      await act(async () => {
        fireEvent.press(getByTestId("connect-btn"));
      });

      // Wait for connection to complete
      await waitFor(() => {
        expect(getByTestId("wallet-state").children[0]).toBe("connected");
      });

      // Verify address is stored in context
      expect(getByTestId("wallet-address").children[0]).toBe(mockAddress);

      // Verify address is persisted in secure storage
      const storedAddress = await secureStorage.getWalletAddress();
      expect(storedAddress).toBe(mockAddress);

      // Verify connection state is persisted
      const connectionState = await secureStorage.getConnectionState();
      expect(connectionState).toEqual({
        connected: true,
        address: mockAddress,
        timestamp: expect.any(Number),
      });

      // Verify wallet kit methods were called
      expect(mockWalletKit.connect).toHaveBeenCalledTimes(1);
      expect(mockWalletKit.getPublicKey).toHaveBeenCalledTimes(1);
    });

    it("should restore connection state from secure storage on app restart", async () => {
      // Pre-populate secure storage with connection state
      await secureStorage.setWalletAddress(mockAddress);
      await secureStorage.setConnectionState({
        connected: true,
        address: mockAddress,
        timestamp: Date.now(),
      });

      // Mock wallet kit to return connected state
      mockWalletKit.isConnected.mockResolvedValue(true);
      mockWalletKit.getPublicKey.mockResolvedValue(mockAddress);

      const { getByTestId } = render(<TestApp />);

      // Wait for initialization to complete
      await waitFor(() => {
        expect(getByTestId("wallet-state").children[0]).toBe("connected");
      });

      // Verify address is restored in context
      expect(getByTestId("wallet-address").children[0]).toBe(mockAddress);

      // Verify wallet kit was queried for current state
      expect(mockWalletKit.isConnected).toHaveBeenCalledTimes(1);
      expect(mockWalletKit.getPublicKey).toHaveBeenCalledTimes(1);
    });
  });

  describe("Disconnect Flow", () => {
    it("should disconnect wallet and clear context", async () => {
      // Setup initial connected state
      await secureStorage.setWalletAddress(mockAddress);
      await secureStorage.setConnectionState({
        connected: true,
        address: mockAddress,
        timestamp: Date.now(),
      });

      mockWalletKit.isConnected.mockResolvedValue(true);
      mockWalletKit.getPublicKey.mockResolvedValue(mockAddress);
      mockWalletKit.disconnect.mockResolvedValue(undefined);

      const { getByTestId } = render(<TestApp />);

      // Wait for initial connection to be restored
      await waitFor(() => {
        expect(getByTestId("wallet-state").children[0]).toBe("connected");
      });

      // Trigger disconnect
      await act(async () => {
        fireEvent.press(getByTestId("disconnect-btn"));
      });

      // Wait for disconnection to complete
      await waitFor(() => {
        expect(getByTestId("wallet-state").children[0]).toBe("disconnected");
      });

      // Verify context is cleared
      expect(getByTestId("wallet-address").children[0]).toBe("null");

      // Verify secure storage is cleared
      const storedAddress = await secureStorage.getWalletAddress();
      expect(storedAddress).toBeNull();

      const connectionState = await secureStorage.getConnectionState();
      expect(connectionState).toBeNull();

      // Verify wallet kit disconnect was called
      expect(mockWalletKit.disconnect).toHaveBeenCalledTimes(1);
    });

    it("should handle disconnect when not connected", async () => {
      // Start with disconnected state
      mockWalletKit.isConnected.mockResolvedValue(false);
      mockWalletKit.disconnect.mockResolvedValue(undefined);

      const { getByTestId } = render(<TestApp />);

      // Wait for initial state
      await waitFor(() => {
        expect(getByTestId("wallet-state").children[0]).toBe("disconnected");
      });

      // Trigger disconnect (should be safe to call)
      await act(async () => {
        fireEvent.press(getByTestId("disconnect-btn"));
      });

      // State should remain disconnected
      expect(getByTestId("wallet-state").children[0]).toBe("disconnected");
      expect(getByTestId("wallet-address").children[0]).toBe("null");

      // Disconnect should still be called for cleanup
      expect(mockWalletKit.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe("Connection Failure Scenarios", () => {
    it("should show error state when connection fails", async () => {
      // Setup connection failure
      const connectionError = new Error("User rejected connection");
      mockWalletKit.connect.mockRejectedValue(connectionError);

      const { getByTestId } = render(<TestApp />);

      await waitFor(() => {
        expect(getByTestId("wallet-state").children[0]).toBe("disconnected");
      });

      // Trigger connect
      await act(async () => {
        fireEvent.press(getByTestId("connect-btn"));
      });

      // Wait for error state
      await waitFor(() => {
        expect(getByTestId("wallet-state").children[0]).toBe("error");
      });

      // Verify error is shown
      expect(getByTestId("wallet-error").children[0]).toBe("User rejected connection");

      // Verify no address is stored
      expect(getByTestId("wallet-address").children[0]).toBe("null");

      const storedAddress = await secureStorage.getWalletAddress();
      expect(storedAddress).toBeNull();
    });

    it("should show error state when wallet kit is not available", async () => {
      // Mock wallet kit as unavailable
      mockWalletKit.connect.mockRejectedValue(new Error("Wallet kit not available"));

      const { getByTestId } = render(<TestApp />);

      await waitFor(() => {
        expect(getByTestId("wallet-state").children[0]).toBe("disconnected");
      });

      // Trigger connect
      await act(async () => {
        fireEvent.press(getByTestId("connect-btn"));
      });

      // Wait for error state
      await waitFor(() => {
        expect(getByTestId("wallet-state").children[0]).toBe("error");
      });

      // Verify error is shown
      expect(getByTestId("wallet-error").children[0]).toBe("Wallet kit not available");
    });

    it("should handle network errors gracefully", async () => {
      // Setup network error during connection
      mockWalletKit.connect.mockResolvedValue({ publicKey: mockAddress });
      mockWalletKit.getPublicKey.mockRejectedValue(new Error("Network error"));

      const { getByTestId } = render(<TestApp />);

      await waitFor(() => {
        expect(getByTestId("wallet-state").children[0]).toBe("disconnected");
      });

      // Trigger connect
      await act(async () => {
        fireEvent.press(getByTestId("connect-btn"));
      });

      // Wait for error state
      await waitFor(() => {
        expect(getByTestId("wallet-state").children[0]).toBe("error");
      });

      // Verify error is shown
      expect(getByTestId("wallet-error").children[0]).toBe("Network error");
    });

    it("should retry connection after error", async () => {
      // Setup initial failure then success
      mockWalletKit.connect
        .mockRejectedValueOnce(new Error("Connection failed"))
        .mockResolvedValueOnce({ publicKey: mockAddress });
      mockWalletKit.getPublicKey.mockResolvedValue(mockAddress);
      mockWalletKit.isConnected.mockResolvedValue(true);

      const { getByTestId } = render(<TestApp />);

      await waitFor(() => {
        expect(getByTestId("wallet-state").children[0]).toBe("disconnected");
      });

      // First connection attempt fails
      await act(async () => {
        fireEvent.press(getByTestId("connect-btn"));
      });

      await waitFor(() => {
        expect(getByTestId("wallet-state").children[0]).toBe("error");
      });

      // Second connection attempt succeeds
      await act(async () => {
        fireEvent.press(getByTestId("connect-btn"));
      });

      await waitFor(() => {
        expect(getByTestId("wallet-state").children[0]).toBe("connected");
      });

      expect(getByTestId("wallet-address").children[0]).toBe(mockAddress);
      expect(mockWalletKit.connect).toHaveBeenCalledTimes(2);
    });
  });

  describe("State Persistence", () => {
    it("should maintain connection state across component remounts", async () => {
      // Setup connected state
      await secureStorage.setWalletAddress(mockAddress);
      await secureStorage.setConnectionState({
        connected: true,
        address: mockAddress,
        timestamp: Date.now(),
      });

      mockWalletKit.isConnected.mockResolvedValue(true);
      mockWalletKit.getPublicKey.mockResolvedValue(mockAddress);

      // First render
      const { getByTestId, unmount } = render(<TestApp />);

      await waitFor(() => {
        expect(getByTestId("wallet-state").children[0]).toBe("connected");
      });

      // Unmount and remount
      unmount();
      const { getByTestId: getByTestId2 } = render(<TestApp />);

      // Should restore connected state
      await waitFor(() => {
        expect(getByTestId2("wallet-state").children[0]).toBe("connected");
      });

      expect(getByTestId2("wallet-address").children[0]).toBe(mockAddress);
    });

    it("should clear stale connection state when wallet is no longer connected", async () => {
      // Setup stale connection state in storage
      await secureStorage.setWalletAddress(mockAddress);
      await secureStorage.setConnectionState({
        connected: true,
        address: mockAddress,
        timestamp: Date.now() - 86400000, // 24 hours ago
      });

      // But wallet kit reports disconnected
      mockWalletKit.isConnected.mockResolvedValue(false);

      const { getByTestId } = render(<TestApp />);

      // Should detect stale state and clear it
      await waitFor(() => {
        expect(getByTestId("wallet-state").children[0]).toBe("disconnected");
      });

      expect(getByTestId("wallet-address").children[0]).toBe("null");

      // Verify storage is cleared
      const storedAddress = await secureStorage.getWalletAddress();
      expect(storedAddress).toBeNull();
    });
  });
});
