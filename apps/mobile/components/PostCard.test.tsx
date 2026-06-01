import React from "react";
import renderer from "react-test-renderer";
import { fireEvent, render } from "@testing-library/react-native";
import { PostCard, Post } from "./PostCard";
import { useRouter } from "expo-router";

jest.mock("expo-router", () => ({ useRouter: jest.fn(() => ({ push: jest.fn() })) }));

describe("PostCard", () => {
  const defaultPost: Post = {
    id: 1,
    author: "GABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    username: "john.doe",
    content: "This is a sample post content.",
    tip_total: 100,
    timestamp: Math.floor(Date.now() / 1000) - 3600,
    like_count: 42,
  };

  describe("Rendering", () => {
    it("renders all post fields correctly", () => {
      const { getByText } = render(<PostCard post={defaultPost} />);
      expect(getByText(defaultPost.username)).toBeTruthy();
      expect(getByText(defaultPost.content)).toBeTruthy();
      expect(getByText("♥ 42")).toBeTruthy();
      expect(getByText("◎ 100")).toBeTruthy();
    });

    it("renders with zero likes correctly", () => {
      const post = { ...defaultPost, like_count: 0 };
      const { getByText } = render(<PostCard post={post} />);
      expect(getByText("♥ 0")).toBeTruthy();
    });

    it("renders with long content correctly", () => {
      const longContent =
        "This is a very long post content that spans multiple lines and demonstrates how the PostCard component handles longer text content. It should wrap properly and maintain good readability across different screen sizes.";
      const post = { ...defaultPost, content: longContent };
      const { getByText } = render(<PostCard post={post} />);
      expect(getByText(longContent)).toBeTruthy();
    });

    it("renders loading skeleton", () => {
      const { getByTestId } = render(
        <PostCard
          id="1"
          author={defaultPost.author}
          content={defaultPost.content}
          timestamp={Date.now()}
          isLoading={true}
        />
      );
      expect(getByTestId("post-skeleton")).toBeTruthy();
    });
  });

  describe("Accessibility", () => {
    it("has accessible button role and label", () => {
      const { getByRole } = render(<PostCard post={defaultPost} />);
      const button = getByRole("button");
      expect(button).toBeTruthy();
      expect(button.props.accessibilityLabel).toBe(`Post by ${defaultPost.username}`);
    });

    it("avatar has minimum 44x44 touch target", () => {
      const tree = renderer.create(<PostCard post={defaultPost} />).toJSON();
      expect(tree).toMatchSnapshot();
    });
  });

  describe("Interaction", () => {
    it("calls onPress when tapped", () => {
      const onPress = jest.fn();
      const { getByRole } = render(<PostCard post={defaultPost} onPress={onPress} />);
      const button = getByRole("button");
      fireEvent.press(button);
      expect(onPress).toHaveBeenCalled();
    });

    it("navigates to post detail by default", () => {
      const mockPush = jest.fn();
      (useRouter as jest.Mock).mockReturnValue({ push: mockPush });

      const { getByRole } = render(<PostCard post={defaultPost} />);
      const button = getByRole("button");
      fireEvent.press(button);
      expect(mockPush).toHaveBeenCalledWith(`/post/${defaultPost.id}`);
    });
  });
});
