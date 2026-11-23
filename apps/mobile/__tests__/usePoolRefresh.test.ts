/**
 * Refresh behaviour of `usePool` (FE-21).
 *
 * A confirmed deposit must re-read the pool so the balance on screen stops
 * being one transaction stale, and it must do that *without* blanking the
 * screen back to a spinner.
 */

import { act, renderHook, waitFor } from "@testing-library/react-native";

import { usePool } from "../hooks/usePool";
import * as indexerClient from "../utils/indexerClient";

jest.mock("../utils/indexerClient", () => {
  const actual = jest.requireActual("../utils/indexerClient");
  return { ...actual, getPoolById: jest.fn() };
});

const mockedGetPoolById = indexerClient.getPoolById as jest.MockedFunction<
  typeof indexerClient.getPoolById
>;

const samplePool = (balance: bigint) => ({
  pool_id: "creator-fund",
  token: "XLM",
  balance,
  admins: [],
  threshold: 1,
  token_decimals: 7,
});

describe("usePool — refresh after a confirmed transaction", () => {
  beforeEach(() => {
    mockedGetPoolById.mockReset();
  });

  it("re-reads the pool and exposes the new balance", async () => {
    mockedGetPoolById.mockResolvedValueOnce(samplePool(100n));

    const { result } = renderHook(() => usePool("creator-fund"));
    await waitFor(() => expect(result.current.pool?.balance).toBe(100n));

    mockedGetPoolById.mockResolvedValueOnce(samplePool(150n));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.pool?.balance).toBe(150n);
    expect(mockedGetPoolById).toHaveBeenCalledTimes(2);
  });

  it("keeps the current pool on screen while refreshing", async () => {
    // The post-deposit refresh must not blank the screen: the balance is stale
    // by one transaction and the user should watch it update.
    mockedGetPoolById.mockResolvedValueOnce(samplePool(100n));

    const { result } = renderHook(() => usePool("creator-fund"));
    await waitFor(() => expect(result.current.pool?.balance).toBe(100n));

    let resolveSecond: (value: ReturnType<typeof samplePool>) => void = () => {};
    mockedGetPoolById.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSecond = resolve; })
    );

    act(() => {
      void result.current.refresh();
    });

    // Mid-flight: still showing data, flagged as refreshing, not `loading`.
    expect(result.current.pool?.balance).toBe(100n);
    expect(result.current.refreshing).toBe(true);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      resolveSecond(samplePool(150n));
    });

    expect(result.current.refreshing).toBe(false);
    expect(result.current.pool?.balance).toBe(150n);
  });

  it("returns a promise that resolves once the new values are in state", async () => {
    // The deposit form needs to know when the refreshed balance is on screen;
    // the old fire-and-forget `refresh` gave it nothing to await.
    mockedGetPoolById.mockResolvedValueOnce(samplePool(100n));

    const { result } = renderHook(() => usePool("creator-fund"));
    await waitFor(() => expect(result.current.pool).not.toBeNull());

    mockedGetPoolById.mockResolvedValueOnce(samplePool(175n));
    await act(async () => {
      await result.current.refresh();
    });

    // No extra tick needed: the value is already committed when the promise resolves.
    expect(result.current.pool?.balance).toBe(175n);
  });

  it("shows the full loading state when there is nothing to keep on screen", async () => {
    let resolveFirst: (value: ReturnType<typeof samplePool>) => void = () => {};
    mockedGetPoolById.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve; })
    );

    const { result } = renderHook(() => usePool("creator-fund"));

    expect(result.current.loading).toBe(true);

    await act(async () => {
      resolveFirst(samplePool(100n));
    });

    expect(result.current.loading).toBe(false);
  });
});
