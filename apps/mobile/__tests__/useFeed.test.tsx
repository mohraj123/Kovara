import React from "react";
import { Text } from "react-native";
import { act, render, screen, waitFor } from "@testing-library/react-native";
import { addMockFeedPost, useFeed } from "../hooks/useFeed";

function HookProbe({ pollingIntervalMs }: { pollingIntervalMs?: number }) {
  const { posts } = useFeed({ pollingIntervalMs });

  return (
    <>
      {posts.map((post) => (
        <Text key={post.id}>{post.content}</Text>
      ))}
    </>
  );
}

describe("useFeed polling", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("refreshes the feed when a new post arrives during polling", async () => {
    render(<HookProbe pollingIntervalMs={10} />);

    act(() => {
      jest.advanceTimersByTime(400);
    });

    await waitFor(() => {
      expect(screen.getByText("Just deployed my first smart contract on Stellar! 🚀")).toBeTruthy();
    });

    addMockFeedPost({
      id: 6,
      author: "GNEW9876543210ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      username: "live_user",
      content: "Fresh update from the feed",
      tip_total: 10,
      timestamp: Math.floor(Date.now() / 1000),
      like_count: 1,
    });

    act(() => {
      jest.advanceTimersByTime(10);
    });

    act(() => {
      jest.advanceTimersByTime(400);
    });

    await waitFor(() => {
      expect(screen.getByText("Fresh update from the feed")).toBeTruthy();
    });
  });
});
