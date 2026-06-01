import React from "react";
import { render, fireEvent } from "@testing-library/react-native";
import { PostCard } from "./PostCard";

const mockPost = {
  id: "1",
  author: "GABCDEFGHIJK",
  username: "alice",
  content: "This is a test post",
  tip_total: 10,
  timestamp: Math.floor(Date.now() / 1000) - 30,
  like_count: 5,
};

describe("PostCard", () => {
  it("renders post details correctly", () => {
    const { getByText } = render(<PostCard post={mockPost} />);

    expect(getByText("alice")).toBeTruthy();
    expect(getByText("This is a test post")).toBeTruthy();
    expect(getByText("♥ 5")).toBeTruthy();
    expect(getByText("◎ 10")).toBeTruthy();
  });

  it("triggers onPress when clicked", () => {
    const mockOnPress = jest.fn();
    const { getByRole } = render(<PostCard post={mockPost} onPress={mockOnPress} />);

    const button = getByRole("button");
    fireEvent.press(button);

    expect(mockOnPress).toHaveBeenCalledTimes(1);
  });
});
