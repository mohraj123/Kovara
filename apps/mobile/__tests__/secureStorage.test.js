/**
 * secureStorage fallback contract (FE-30).
 *
 * This suite deliberately imports the **TypeScript** module. `utils/secureStorage.js`
 * used to shadow it — `js` precedes `ts` in both Metro's and Jest's resolution
 * order — so `require('../utils/secureStorage')` bound to the pre-migration
 * copy, which lacked the network-settings API `NetworkContext` depends on and
 * had none of the error handling below. The stale copy has been removed.
 *
 * Secure storage caches a session; it is not the session. Every operation
 * therefore resolves rather than throwing, so an unavailable keychain can never
 * crash the app or strand the user in a state no screen can escape.
 */
const secure = require('../utils/secureStorage');

jest.mock('expo-secure-store', () => {
    let store = {};
    let failing = false;
    const fail = () => {
        if (failing) {
            throw new Error('Keychain is locked');
        }
    };
    return {
        ALWAYS_THIS_DEVICE_ONLY: 'ALWAYS_THIS_DEVICE_ONLY',
        __setFailing: (value) => { failing = value; },
        __reset: () => { store = {}; failing = false; },
        setItemAsync: async (key, value) => { fail(); store[key] = value; return Promise.resolve(); },
        getItemAsync: async (key) => { fail(); return Promise.resolve(store[key] ?? null); },
        deleteItemAsync: async (key) => { fail(); delete store[key]; return Promise.resolve(); }
    };
});

const SecureStore = require('expo-secure-store');

beforeEach(() => {
    SecureStore.__reset();
    secure.resetSecureStorage();
});

describe('secureStorage round-trip', () => {
    it('sets and gets wallet address', async () => {
        await secure.setWalletAddress('0xabc');
        expect(await secure.getWalletAddress()).toBe('0xabc');
    });

    it('deletes wallet address', async () => {
        await secure.setWalletAddress('0x123');
        await secure.deleteWalletAddress();
        expect(await secure.getWalletAddress()).toBeNull();
    });

    it('sets and gets connection state', async () => {
        const state = { connected: true, provider: 'metamask' };
        await secure.setConnectionState(state);
        expect(await secure.getConnectionState()).toEqual(state);
    });

    it('exposes generic get/set/delete', async () => {
        await secure.secureStorage.set(secure.StorageKey.AuthToken, { token: 't' });
        expect(await secure.secureStorage.get(secure.StorageKey.AuthToken)).toEqual({ token: 't' });
        await secure.secureStorage.delete(secure.StorageKey.AuthToken);
        expect(await secure.secureStorage.get(secure.StorageKey.AuthToken)).toBeNull();
    });

    it('round-trips network settings, which the stale .js copy did not expose', async () => {
        await secure.setNetworkSettings({ network: 'TESTNET' });
        expect(await secure.getNetworkSettings()).toEqual({ network: 'TESTNET' });
        await secure.deleteNetworkSettings();
        expect(await secure.getNetworkSettings()).toBeNull();
    });
});

describe('secureStorage when secure storage is unavailable (FE-30)', () => {
    beforeEach(() => {
        SecureStore.__setFailing(true);
    });

    it('reports the keychain as unavailable without throwing', async () => {
        expect(secure.isSecureStorageAvailable()).toBe(true);
        await secure.getWalletAddress();
        expect(secure.isSecureStorageAvailable()).toBe(false);
    });

    it('resolves reads to null instead of rejecting', async () => {
        // The caller reads this as "no stored session" and offers a reconnect,
        // rather than surfacing a raw SecureStore error.
        await expect(secure.getWalletAddress()).resolves.toBeNull();
        await expect(secure.getConnectionState()).resolves.toBeNull();
    });

    it('resolves writes and deletes instead of rejecting', async () => {
        await expect(secure.setWalletAddress('0xabc')).resolves.toBeUndefined();
        await expect(secure.setConnectionState({ connected: true, address: 'G', timestamp: 1 }))
            .resolves.toBeUndefined();
        await expect(secure.deleteWalletAddress()).resolves.toBeUndefined();
        await expect(secure.deleteConnectionState()).resolves.toBeUndefined();
    });

    it('never rejects, so a caller awaiting Promise.all cannot be stranded', async () => {
        // WalletContext.disconnect() awaits both deletes; a rejection here left
        // the wallet stuck in its previous state with no way out.
        await expect(
            Promise.all([secure.deleteWalletAddress(), secure.deleteConnectionState()])
        ).resolves.toEqual([undefined, undefined]);
    });

    it('treats a corrupt entry as absent rather than as an outage', async () => {
        SecureStore.__setFailing(false);
        await SecureStore.setItemAsync(secure.StorageKey.WalletAddress, '{not json');
        await expect(secure.getWalletAddress()).resolves.toBeNull();
        // A corrupt value is not an unavailable keychain.
        expect(secure.isSecureStorageAvailable()).toBe(true);
    });
});
