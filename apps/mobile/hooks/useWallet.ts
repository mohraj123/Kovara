/**
 * useWallet — convenience hook for consuming the global WalletContext.
 *
 * Returns { address, connected, network, connect, disconnect } as specified
 * by issue #254, plus the full state machine value and error for advanced use.
 *
 * Must be rendered inside <WalletProvider> (added to the root layout).
 */
import { useWalletContext } from "../context/WalletContext";

export interface UseWalletReturn {
  /** Stellar public key, or null when disconnected */
  address: string | null;
  /** True when the wallet is in the "connected" state */
  connected: boolean;
  /** Active network identifier (e.g. "TESTNET") */
  network: string | null;
  /** Initiate wallet connection */
  connect: () => Promise<void>;
  /** Disconnect and clear persisted state */
  disconnect: () => Promise<void>;
}

export function useWallet(): UseWalletReturn {
  const { wallet, state, connect, disconnect } = useWalletContext();

  return {
    address: wallet.address,
    connected: state === "connected",
    network: wallet.network,
    connect,
    disconnect,
  };
}
