import React from "react";
import { Alert } from "react-native";
import { fireEvent, render, waitFor } from "@testing-library/react-native";

import CreatePostScreen, * as createPostScreen from "./create-post";
import { resolvePendingRequest } from "../../mini-apps/bridge";

const back = jest.fn();
const push = jest.fn();
const replace = jest.fn();

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ requestId: "req-1" }),
  useRouter: () => ({ back, push, replace }),
}));

jest.mock("../../mini-apps/bridge", () => ({
  resolvePendingRequest: jest.fn(),
}));

describe("CreatePostScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("keeps the compose view active when submission fails", async () => {
    jest.spyOn(createPostScreen, "submitCreatePost").mockRejectedValueOnce(new Error("boom"));
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});

    const { getByPlaceholderText, getByText } = render(<CreatePostScreen />);

    fireEvent.changeText(getByPlaceholderText("What's on your mind?"), "Hello world");
    fireEvent.press(getByText("Post"));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());

    expect(back).not.toHaveBeenCalled();
    expect(resolvePendingRequest).not.toHaveBeenCalled();
    expect(getByPlaceholderText("What's on your mind?").props.value).toBe("Hello world");
    expect(getByText("Post")).toBeTruthy();
  });
});
