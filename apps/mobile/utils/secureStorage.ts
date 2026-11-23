import * as SecureStore from "expo-secure-store";

const StorageKey = {
  WalletAddress: "wallet_address",
  ConnectionState: "connection_state",
  AuthToken: "auth_token",
  NetworkSettings: "network_settings",
};

export interface ConnectionState {
  connected: boolean;
  address: string;
  timestamp: number;
}

/**
 * Whether SecureStore has failed during this app session.
 *
 * Read by the wallet layer to tell "this account has no stored session" apart
 * from "we could not read the keychain". Without the distinction a locked
 * keychain, a device with no secure enclave, or a web build where
 * `expo-secure-store` is unsupported all surface as a wallet error, and the
 * user is offered a reconnect that cannot fix anything (FE-30).
 */
let storageUnavailable = false;

/** True once any SecureStore call has failed. Cleared by {@link resetSecureStorage}. */
export function isSecureStorageAvailable(): boolean {
  return !storageUnavailable;
}

/** Test hook: clear the module-level availability flag. */
export function resetSecureStorage(): void {
  storageUnavailable = false;
}

/**
 * Run a SecureStore operation, degrading instead of throwing.
 *
 * Every operation resolves — reads return `null`, writes and deletes are
 * no-ops — and the failure is recorded on {@link isSecureStorageAvailable} so
 * the caller can report it. Secure storage is a cache of a session, not the
 * session itself: the server is the source of truth, so failing to read or
 * write it must not crash the app or strand the user in a state no screen can
 * escape.
 */
async function withStorage<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch {
    // Locked keychain, biometric prompt cancelled, unsupported platform, or a
    // corrupted entry: all recoverable by reconnecting from scratch.
    storageUnavailable = true;
    return fallback;
  }
}

async function setItem(key: string, value: unknown): Promise<void> {
  const payload = JSON.stringify(value);
  await withStorage(
    () =>
      SecureStore.setItemAsync(key, payload, {
        keychainAccessible: SecureStore.ALWAYS_THIS_DEVICE_ONLY,
      }),
    undefined
  );
}

async function getItem<T>(key: string): Promise<T | null> {
  return withStorage<T | null>(async () => {
    const item = await SecureStore.getItemAsync(key);
    if (!item) return null;
    try {
      return JSON.parse(item) as T;
    } catch {
      // A corrupt entry is not an unavailable keychain: drop it and report
      // "no value" so the caller re-creates it rather than failing to start.
      return null;
    }
  }, null);
}

async function deleteItem(key: string): Promise<void> {
  await withStorage(() => SecureStore.deleteItemAsync(key), undefined);
}

export async function setWalletAddress(address: string): Promise<void> {
  return setItem(StorageKey.WalletAddress, address);
}

export async function getWalletAddress(): Promise<string | null> {
  return getItem<string>(StorageKey.WalletAddress);
}

export async function deleteWalletAddress(): Promise<void> {
  return deleteItem(StorageKey.WalletAddress);
}

export async function setConnectionState(state: ConnectionState): Promise<void> {
  return setItem(StorageKey.ConnectionState, state);
}

export async function getConnectionState(): Promise<ConnectionState | null> {
  return getItem<ConnectionState>(StorageKey.ConnectionState);
}

export async function deleteConnectionState(): Promise<void> {
  return deleteItem(StorageKey.ConnectionState);
}

export async function setNetworkSettings(settings: unknown): Promise<void> {
  return setItem(StorageKey.NetworkSettings, settings);
}

export async function getNetworkSettings<T>(): Promise<T | null> {
  return getItem<T>(StorageKey.NetworkSettings);
}

export async function deleteNetworkSettings(): Promise<void> {
  return deleteItem(StorageKey.NetworkSettings);
}

export { StorageKey, setItem, getItem, deleteItem };

export const secureStorage = {
  get: getItem,
  set: setItem,
  delete: deleteItem,
};
