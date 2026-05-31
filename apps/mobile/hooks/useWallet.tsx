/**
 * Re-exports from the canonical WalletContext for backwards compatibility.
 *
 * New code should import directly from:
 *   - context/WalletContext  (WalletProvider, useWalletContext, types)
 *   - hooks/useWallet        (useWallet — simplified hook)
 */
export {
  WalletProvider,
  useWalletContext as useWallet,
  WalletContext,
  type WalletContextType,
  type WalletState,
  type WalletInfo,
} from "../context/WalletContext";
