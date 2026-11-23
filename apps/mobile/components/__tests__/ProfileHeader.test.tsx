import React from "react";
import { act, fireEvent, render, renderHook, waitFor } from "@testing-library/react-native";
import { useRouter } from "expo-router";

import ProfileHeader, {
  USERNAME_MAX_LENGTH,
  isDisplayableBannerUrl,
  validateBannerUrl,
  validateUsername,
} from "../ProfileHeader";
import EditProfileScreen, { validateProfileForm } from "../../app/profile/edit";
import { resolveProfileSaveError, useProfile } from "../../hooks/useProfile";
import { submitProfileTransaction } from "../../hooks/profileContract";

const mockGetProfile = jest.fn();

jest.mock("../../../../packages/sdk/src/client", () => ({
  KovaraClient: jest.fn().mockImplementation(() => ({
    getProfile: (...args: unknown[]) => mockGetProfile(...args),
  })),
}));

jest.mock("../../hooks/profileContract", () => ({
  submitProfileTransaction: jest.fn(),
}));

jest.mock("../../hooks/useNetwork", () => ({
  useNetwork: () => ({ rpcUrl: "https://rpc.test", contractId: "CTEST" }),
}));

const ME = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

jest.mock("../../hooks/useWallet", () => ({
  useWallet: () => ({ address: ME, connected: true }),
}));

jest.mock("../../hooks/useFollowers", () => ({
  useFollowers: () => ({ users: [], refresh: jest.fn() }),
}));

jest.mock("../../hooks/useFollowing", () => ({
  useFollowing: () => ({ users: [], refresh: jest.fn() }),
}));

const mockToast = {
  showPending: jest.fn(),
  showSuccess: jest.fn(),
  showError: jest.fn(),
};

jest.mock("../../context/ToastContext", () => ({
  useToast: () => mockToast,
}));

const mockSubmit = submitProfileTransaction as jest.MockedFunction<typeof submitProfileTransaction>;

const ALICE = "GALICEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BOB = "GBOBBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function renderHeader(bannerUrl?: string | null) {
  return render(
    <ProfileHeader
      profile={{
        address: "GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        username: "alice",
        bannerUrl,
      }}
      followerCount={12}
      followingCount={4}
      isFollowing={false}
      onFollowersPress={() => undefined}
      onFollowingPress={() => undefined}
      onEditPress={() => undefined}
      onToggleFollow={() => undefined}
    />
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("ProfileHeader", () => {
  it("renders a banner image when a banner URL is provided", () => {
    const { getByTestId } = renderHeader("https://example.com/banner.jpg");

    expect(getByTestId("profile-banner-image")).toBeTruthy();
  });

  it("does not render banners that fail URL constraints", () => {
    expect(renderHeader("javascript:alert(1)").queryByTestId("profile-banner-image")).toBeNull();
    expect(renderHeader("not a url").queryByTestId("profile-banner-image")).toBeNull();
    expect(renderHeader(null).queryByTestId("profile-banner-image")).toBeNull();
  });
});

describe("profile field validation (FE-13)", () => {
  it("matches contract username constraints", () => {
    expect(validateUsername("")).toBe("Username is required.");
    expect(validateUsername("   ")).toBe("Username is required.");
    expect(validateUsername("ab")).toMatch(/at least 3/);
    expect(validateUsername("a".repeat(USERNAME_MAX_LENGTH + 1))).toMatch(/32 characters or fewer/);
    expect(validateUsername("bad name")).toMatch(/letters, numbers, and underscores/);
    expect(validateUsername("bad-name")).toMatch(/letters, numbers, and underscores/);
    expect(validateUsername("abc")).toBeNull();
    expect(validateUsername("a".repeat(USERNAME_MAX_LENGTH))).toBeNull();
    expect(validateUsername(" satoshi_99 ")).toBeNull();
  });

  it("accepts optional http(s) banner URLs only", () => {
    expect(validateBannerUrl("")).toBeNull();
    expect(validateBannerUrl("https://example.com/banner.jpg")).toBeNull();
    expect(validateBannerUrl("http://cdn.example.co.uk:8080/a.png?x=1#y")).toBeNull();
    expect(validateBannerUrl("ftp://example.com/a.png")).toMatch(/http:\/\/ or https:\/\//);
    expect(validateBannerUrl("javascript:alert(1)")).toMatch(/http:\/\/ or https:\/\//);
    expect(validateBannerUrl("https://")).toBe("Enter a valid banner URL.");
    expect(validateBannerUrl("https://exa mple.com")).toBe("Enter a valid banner URL.");
    expect(validateBannerUrl("https://user:pw@evil.com/a.png")).toBe("Enter a valid banner URL.");
    expect(validateBannerUrl("https://nodot")).toBe("Enter a valid banner URL.");
    expect(validateBannerUrl(`https://example.com/${"a".repeat(2048)}`)).toMatch(/2048 characters/);
    expect(isDisplayableBannerUrl("https://example.com/a.png")).toBe(true);
    expect(isDisplayableBannerUrl("")).toBe(false);
  });

  it("reports one error per invalid field", () => {
    expect(
      validateProfileForm({ username: "x", bannerUrl: "nope", creatorToken: "GSHORT" })
    ).toEqual({
      username: expect.stringMatching(/at least 3/),
      bannerUrl: expect.stringMatching(/http/),
      creatorToken: expect.stringMatching(/valid Stellar address/),
    });
    expect(validateProfileForm({ username: "alice", bannerUrl: "", creatorToken: "" })).toEqual({});
  });

  it("shows field-specific errors and does not submit invalid edits", () => {
    const { getByLabelText, getByTestId, queryByTestId } = render(<EditProfileScreen />);

    fireEvent.changeText(getByLabelText("Username"), "a!");
    fireEvent.changeText(getByLabelText("Profile banner URL"), "ftp://example.com/a.png");
    fireEvent.changeText(getByLabelText("Creator token address"), "not-a-token");
    fireEvent.press(getByLabelText("Save profile"));

    expect(getByTestId("username-error").props.children).toMatch(/at least 3/);
    expect(getByTestId("banner-url-error").props.children).toMatch(/http:\/\/ or https:\/\//);
    expect(getByTestId("creator-token-error").props.children).toMatch(/valid Stellar address/);
    expect(mockSubmit).not.toHaveBeenCalled();

    // Fixing a field clears only that field's error.
    fireEvent.changeText(getByLabelText("Profile banner URL"), "https://example.com/a.png");
    expect(queryByTestId("banner-url-error")).toBeNull();
    expect(getByTestId("username-error")).toBeTruthy();
  });
});

describe("profile save failures (FE-14)", () => {
  it("keeps edits and shows transaction failure details after a failed save", async () => {
    mockSubmit.mockRejectedValueOnce(
      new Error("HostError: Error(Contract, #5) — simulation failed for set_profile")
    );
    const router = useRouter();
    const { getByLabelText, getByTestId, findByTestId } = render(<EditProfileScreen />);

    fireEvent.changeText(getByLabelText("Username"), "satoshi");
    fireEvent.changeText(getByLabelText("Profile banner URL"), "https://example.com/b.png");
    fireEvent.changeText(getByLabelText("Creator token address"), TOKEN);
    await act(async () => {
      fireEvent.press(getByLabelText("Save profile"));
    });

    const banner = await findByTestId("profile-save-error");
    expect(banner).toHaveTextContent(/That username is already taken\./);
    expect(getByTestId("profile-save-error-detail")).toHaveTextContent(/Error\(Contract, #5\)/);
    expect(getByTestId("username-error")).toHaveTextContent("That username is already taken.");

    expect(getByLabelText("Username").props.value).toBe("satoshi");
    expect(getByLabelText("Profile banner URL").props.value).toBe("https://example.com/b.png");
    expect(getByLabelText("Creator token address").props.value).toBe(TOKEN);
    expect(router.back).not.toHaveBeenCalled();
    expect(mockToast.showError).toHaveBeenCalledWith("That username is already taken.", "Profile not saved");
  });

  it("clears the failure once the user retries successfully", async () => {
    mockSubmit.mockRejectedValueOnce(new Error("Request timed out")).mockResolvedValueOnce("txhash123");
    const router = useRouter();
    const { getByLabelText, findByTestId, queryByTestId } = render(<EditProfileScreen />);

    fireEvent.changeText(getByLabelText("Username"), "satoshi");
    await act(async () => {
      fireEvent.press(getByLabelText("Save profile"));
    });
    expect(await findByTestId("profile-save-error")).toHaveTextContent(/Network error/);

    await act(async () => {
      fireEvent.press(getByLabelText("Save profile"));
    });
    expect(queryByTestId("profile-save-error")).toBeNull();
    expect(mockToast.showSuccess).toHaveBeenCalledWith("txhash123");
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("resolves wallet and contract failures into readable messages", () => {
    expect(resolveProfileSaveError(new Error("User rejected the request"))).toEqual({
      message: "You canceled the transaction.",
      detail: "User rejected the request",
    });
    expect(resolveProfileSaveError(new Error("Error(Contract, #40)"))).toMatchObject({
      field: "creatorToken",
    });
    expect(resolveProfileSaveError(new Error("Transaction not confirmed")).message).toMatch(/not confirmed/);
    expect(resolveProfileSaveError(undefined)).toEqual({ message: "Failed to update profile.", detail: null });
  });
});

describe("useProfile address changes (FE-12)", () => {
  it("ignores a stale response that resolves after the address changed", async () => {
    const alice = deferred<{ username: string }>();
    const bob = deferred<{ username: string }>();
    mockGetProfile.mockImplementation((address: string) =>
      address === ALICE ? alice.promise : bob.promise
    );

    const { result, rerender } = renderHook(({ address }) => useProfile(address), {
      initialProps: { address: ALICE },
    });
    expect(result.current.loading).toBe(true);

    rerender({ address: BOB });
    expect(result.current.profile).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => {
      bob.resolve({ username: "bob" });
    });
    await waitFor(() => expect(result.current.profile?.username).toBe("bob"));

    // Alice's slower response must not overwrite Bob's profile.
    await act(async () => {
      alice.resolve({ username: "alice" });
    });
    expect(result.current.profile).toEqual(expect.objectContaining({ address: BOB, username: "bob" }));
    expect(result.current.loading).toBe(false);
  });

  it("does not carry a previous profile or error into the next address", async () => {
    mockGetProfile.mockResolvedValueOnce({ username: "alice" });
    const { result, rerender } = renderHook(({ address }) => useProfile(address), {
      initialProps: { address: ALICE },
    });
    await waitFor(() => expect(result.current.profile?.username).toBe("alice"));

    const bob = deferred<{ username: string }>();
    mockGetProfile.mockReturnValueOnce(bob.promise);
    rerender({ address: BOB });
    expect(result.current.profile).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => {
      bob.reject(new Error("boom"));
    });
    await waitFor(() => expect(result.current.error).toBe("Failed to load profile."));

    mockGetProfile.mockResolvedValueOnce({ username: "alice" });
    rerender({ address: ALICE });
    expect(result.current.error).toBeNull();
    await waitFor(() => expect(result.current.profile?.username).toBe("alice"));
  });

  it("ignores a stale failure from the previous address", async () => {
    const alice = deferred<{ username: string }>();
    mockGetProfile.mockReturnValueOnce(alice.promise).mockResolvedValueOnce({ username: "bob" });

    const { result, rerender } = renderHook(({ address }) => useProfile(address), {
      initialProps: { address: ALICE },
    });
    rerender({ address: BOB });
    await waitFor(() => expect(result.current.profile?.username).toBe("bob"));

    await act(async () => {
      alice.reject(new Error("late failure"));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.profile?.username).toBe("bob");
  });
});
