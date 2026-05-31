// Stub for @stellar/wallet-kit — not available as an npm package
export class WalletKit {
  connect = async () => ({ publicKey: '' });
  disconnect = async () => {};
  getPublicKey = async () => '';
  isConnected = async () => false;
}
export const NETWORK = { TESTNET: 'TESTNET', MAINNET: 'MAINNET' };
