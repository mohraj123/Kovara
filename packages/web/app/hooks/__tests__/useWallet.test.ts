import { renderHook, act, waitFor } from "@testing-library/react";
import { WalletProvider, useWallet } from "../../components/WalletProvider";

/**
 * Unit tests for useWallet hook
 * Tests cover wallet connection, disconnection, and error handling
 */

describe("useWallet", () => {
  // Mock localStorage
  const localStorageMock = (() => {
    let store: Record<string, string> = {};

    return {
      getItem: (key: string) => store[key] || null,
      setItem: (key: string, value: string) => {
        store[key] = value.toString();
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    };
  })();

  // Mock Freighter API
  const mockFreighterApi = {
    getPublicKey: jest.fn(),
    isConnected: jest.fn(),
    onNetworkChange: jest.fn(),
  };

  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
    Object.defineProperty(window, "localStorage", {
      value: localStorageMock,
      writable: true,
    });
    Object.defineProperty(window, "freighterApi", {
      value: mockFreighterApi,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete (window as unknown).freighterApi;
  });

  describe("initial state", () => {
    it("should return initial disconnected state", () => {
      const { result } = renderHook(() => useWallet(), {
        wrapper: WalletProvider,
      });

      expect(result.current).toEqual({
        publicKey: null,
        isConnected: false,
        isConnecting: false,
        error: null,
        connect: expect.any(Function),
        disconnect: expect.any(Function),
      });
    });

    it("should load stored public key from localStorage on mount", async () => {
      const storedKey = "GBRPYHIL2CI3WHZDTOOQFC6EB4RBIGSJRVSBUOYS77TQ7CQK5FHQ6SR";
      localStorageMock.setItem("linkora_wallet_public_key", storedKey);

      const { result } = renderHook(() => useWallet(), {
        wrapper: WalletProvider,
      });

      await waitFor(() => {
        expect(result.current.publicKey).toBe(storedKey);
        expect(result.current.isConnected).toBe(true);
      });
    });
  });

  describe("connect", () => {
    it("should successfully connect wallet", async () => {
      const publicKey = "GBRPYHIL2CI3WHZDTOOQFC6EB4RBIGSJRVSBUOYS77TQ7CQK5FHQ6SR";
      mockFreighterApi.getPublicKey.mockResolvedValueOnce({ publicKey });

      const { result } = renderHook(() => useWallet(), {
        wrapper: WalletProvider,
      });

      await act(async () => {
        await result.current.connect();
      });

      expect(result.current.publicKey).toBe(publicKey);
      expect(result.current.isConnected).toBe(true);
      expect(result.current.isConnecting).toBe(false);
      expect(result.current.error).toBe(null);
      expect(localStorageMock.getItem("linkora_wallet_public_key")).toBe(publicKey);
    });

    it("should show isConnecting state during connection", async () => {
      const publicKey = "GBRPYHIL2CI3WHZDTOOQFC6EB4RBIGSJRVSBUOYS77TQ7CQK5FHQ6SR";
      mockFreighterApi.getPublicKey.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ publicKey }), 100);
          })
      );

      const { result } = renderHook(() => useWallet(), {
        wrapper: WalletProvider,
      });

      await act(async () => {
        await result.current.connect();
      });

      expect(result.current.isConnecting).toBe(false);
      expect(result.current.isConnected).toBe(true);
    });

    it("should handle connection error when Freighter is not installed", async () => {
      delete (window as unknown).freighterApi;

      const { result } = renderHook(() => useWallet(), {
        wrapper: WalletProvider,
      });

      await act(async () => {
        await result.current.connect();
      });

      expect(result.current.isConnected).toBe(false);
      expect(result.current.error).toContain("Freighter wallet not detected");
      expect(result.current.isConnecting).toBe(false);
    });

    it("should handle connection error from Freighter API", async () => {
      const errorMessage = "User rejected connection";
      mockFreighterApi.getPublicKey.mockRejectedValueOnce(new Error(errorMessage));

      const { result } = renderHook(() => useWallet(), {
        wrapper: WalletProvider,
      });

      await act(async () => {
        await result.current.connect();
      });

      expect(result.current.isConnected).toBe(false);
      expect(result.current.error).toBe(errorMessage);
      expect(result.current.publicKey).toBeNull();
    });

    it("should clear previous error on successful connection after error", async () => {
      const publicKey = "GBRPYHIL2CI3WHZDTOOQFC6EB4RBIGSJRVSBUOYS77TQ7CQK5FHQ6SR";

      // First attempt: error
      mockFreighterApi.getPublicKey.mockRejectedValueOnce(new Error("Connection failed"));

      const { result } = renderHook(() => useWallet(), {
        wrapper: WalletProvider,
      });

      await act(async () => {
        await result.current.connect();
      });

      expect(result.current.error).toBe("Connection failed");

      // Second attempt: success
      mockFreighterApi.getPublicKey.mockResolvedValueOnce({ publicKey });

      await act(async () => {
        await result.current.connect();
      });

      expect(result.current.error).toBeNull();
      expect(result.current.publicKey).toBe(publicKey);
    });
  });

  describe("disconnect", () => {
    it("should disconnect wallet and clear state", async () => {
      const publicKey = "GBRPYHIL2CI3WHZDTOOQFC6EB4RBIGSJRVSBUOYS77TQ7CQK5FHQ6SR";
      localStorageMock.setItem("linkora_wallet_public_key", publicKey);

      const { result } = renderHook(() => useWallet(), {
        wrapper: WalletProvider,
      });

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      act(() => {
        result.current.disconnect();
      });

      expect(result.current.publicKey).toBeNull();
      expect(result.current.isConnected).toBe(false);
      expect(result.current.isConnecting).toBe(false);
      expect(result.current.error).toBeNull();
      expect(localStorageMock.getItem("linkora_wallet_public_key")).toBeNull();
    });

    it("should safely disconnect when not connected", () => {
      const { result } = renderHook(() => useWallet(), {
        wrapper: WalletProvider,
      });

      act(() => {
        result.current.disconnect();
      });

      expect(result.current.publicKey).toBeNull();
      expect(result.current.isConnected).toBe(false);
    });
  });

  describe("error handling", () => {
    it("should throw error when used outside WalletProvider", () => {
      // Suppress console.error for this test
      const consoleSpy = jest.spyOn(console, "error").mockImplementationOnce(() => {});

      expect(() => {
        renderHook(() => useWallet());
      }).toThrow("useWallet must be used within a WalletProvider");

      consoleSpy.mockRestore();
    });

    it("should handle non-Error objects in catch block", async () => {
      mockFreighterApi.getPublicKey.mockRejectedValueOnce("Unknown error");

      const { result } = renderHook(() => useWallet(), {
        wrapper: WalletProvider,
      });

      await act(async () => {
        await result.current.connect();
      });

      expect(result.current.error).toBe("Failed to connect wallet");
    });
  });
});
