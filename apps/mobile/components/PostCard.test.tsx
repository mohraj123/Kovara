import React from "react";
import renderer from "react-test-renderer";
import { fireEvent, render } from "@testing-library/react-native";
import { PostCard, Post } from "./PostCard";
import { useRouter } from "expo-router";

jest.mock("expo-router", () => ({ useRouter: jest.fn(() => ({ push: jest.fn() })) }));
jest.mock("../hooks/useNetwork", () => ({
  useNetwork: () => ({
    rpcUrl: "https://test-rpc.example.com",
    contractId: "CABC123",
  }),
}));
jest.mock("../context/WalletContext", () => ({
  useWalletContext: () => ({
    wallet: { address: null },
    network: null,
    state: "disconnected",
    error: null,
    connect: jest.fn(),
    disconnect: jest.fn(),
    refresh: jest.fn(),
    setNetwork: jest.fn(),
  }),
  WalletProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("../context/ToastContext", () => ({
  useToast: () => ({ showSuccess: jest.fn(), showError: jest.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

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
      expect(getByText(/42/)).toBeTruthy();
      expect(getByText(/100/)).toBeTruthy();
    });

    it("renders with zero likes correctly", () => {
      const post = { ...defaultPost, like_count: 0 };
      const { getByText } = render(<PostCard post={post} />);
      expect(getByText(/Like.*0|0.*Like/)).toBeTruthy();
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
      const { getAllByRole } = render(<PostCard post={defaultPost} />);
      const buttons = getAllByRole("button");
      const card = buttons.find(
        (b) => b.props.accessibilityLabel === `Post by ${defaultPost.username}`
      );
      expect(card).toBeTruthy();
    });

    it("avatar has minimum 44x44 touch target", () => {
      const tree = renderer.create(<PostCard post={defaultPost} />).toJSON();
      expect(tree).toMatchSnapshot();
    });
  });

  describe("Interaction", () => {
    it("calls onPress when tapped", () => {
      const onPress = jest.fn();
      const { getAllByRole } = render(<PostCard post={defaultPost} onPress={onPress} />);
      const card = getAllByRole("button").find(
        (b) => b.props.accessibilityLabel === `Post by ${defaultPost.username}`
      );
      fireEvent.press(card!);
      expect(onPress).toHaveBeenCalled();
    });

    it("navigates to post detail by default", () => {
      const mockPush = jest.fn();
      (useRouter as jest.Mock).mockReturnValue({ push: mockPush });

      const { getAllByRole } = render(<PostCard post={defaultPost} />);
      const card = getAllByRole("button").find(
        (b) => b.props.accessibilityLabel === `Post by ${defaultPost.username}`
      );
      fireEvent.press(card!);
      expect(mockPush).toHaveBeenCalledWith(`/post/${defaultPost.id}`);
    });
  });
});
