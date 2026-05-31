import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
} from "react";
import {
  setWalletAddress,
  getWalletAddress,
  deleteWalletAddress,
  setConnectionState,
  getConnectionState,
  deleteConnectionState,
} from "../utils/secureStorage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WalletState =
  | "loading"
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface WalletInfo {
  address: string | null;
  network: string | null;
}

interface StoredConnectionState {
  connected: boolean;
  address: string;
  timestamp: number;
}

export interface WalletContextType {
  /** Current connection state machine value */
  state: WalletState;
  /** Wallet address and network info */
  wallet: WalletInfo;
  /** Last error message, if any */
  error: string | null;
  /** Initiate wallet connection */
  connect: () => Promise<void>;
  /** Disconnect and clear persisted state */
  disconnect: () => Promise<void>;
  /** Re-check connection state (e.g. after app foreground) */
  refresh: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const WalletContext = createContext<WalletContextType | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface WalletProviderProps {
  children: ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps): JSX.Element {
  const [state, setState] = useState<WalletState>("loading");
  const [wallet, setWallet] = useState<WalletInfo>({
    address: null,
    network: null,
  });
  const [error, setError] = useState<string | null>(null);

  // Lazy-loaded wallet kit instance
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [walletKit, setWalletKit] = useState<any | null>(null);

  // Initialize @stellar/wallet-kit on mount
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        const { WalletKit } = await import("@stellar/wallet-kit");
        if (!cancelled) {
          setWalletKit(new WalletKit());
        }
      } catch {
        if (!cancelled) {
          setState("error");
          setError("Wallet kit not available");
        }
      }
    };

    init();
    return () => {
      cancelled = true;
    };
  }, []);

  // Check persisted connection state once wallet kit is ready
  const checkConnectionState = useCallback(async () => {
    if (!walletKit) return;

    try {
      setState("loading");
      setError(null);

      const storedAddress = await getWalletAddress();
      const storedConn = await getConnectionState();

      if (storedAddress && storedConn) {
        const isConnected: boolean = await walletKit.isConnected();

        if (isConnected) {
          const currentAddress: string = await walletKit.getPublicKey();

          if (currentAddress === storedAddress) {
            setWallet({ address: currentAddress, network: "TESTNET" });
            setState("connected");
            return;
          }
        }

        // Stale — clear storage
        await Promise.all([deleteWalletAddress(), deleteConnectionState()]);
      }

      setState("disconnected");
      setWallet({ address: null, network: null });
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [walletKit]);

  useEffect(() => {
    if (walletKit) {
      checkConnectionState();
    }
  }, [walletKit, checkConnectionState]);

  // Connect
  const connect = useCallback(async () => {
    if (!walletKit) {
      setError("Wallet kit not available");
      setState("error");
      return;
    }

    try {
      setState("connecting");
      setError(null);

      const result: { publicKey: string } = await walletKit.connect();
      const address = result.publicKey;

      if (!address) {
        throw new Error("No address returned from wallet");
      }

      const connState: StoredConnectionState = {
        connected: true,
        address,
        timestamp: Date.now(),
      };

      await Promise.all([
        setWalletAddress(address),
        setConnectionState(connState),
      ]);

      setWallet({ address, network: "TESTNET" });
      setState("connected");
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "Connection failed");
      setWallet({ address: null, network: null });
    }
  }, [walletKit]);

  // Disconnect
  const disconnect = useCallback(async () => {
    try {
      setError(null);
      if (walletKit) {
        await walletKit.disconnect();
      }
    } catch {
      // Ignore disconnect errors — always clear local state
    } finally {
      await Promise.all([deleteWalletAddress(), deleteConnectionState()]);
      setWallet({ address: null, network: null });
      setState("disconnected");
    }
  }, [walletKit]);

  const refresh = useCallback(async () => {
    await checkConnectionState();
  }, [checkConnectionState]);

  const value: WalletContextType = {
    state,
    wallet,
    error,
    connect,
    disconnect,
    refresh,
  };

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns wallet state and actions.
 * Must be used inside <WalletProvider>.
 */
export function useWalletContext(): WalletContextType {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWalletContext must be used within a WalletProvider");
  }
  return ctx;
}

export { WalletContext };
