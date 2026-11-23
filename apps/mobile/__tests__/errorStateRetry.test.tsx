/**
 * Terminal vs retryable pool failures (FE-22).
 *
 * A 404 is terminal — retrying cannot bring the pool back — so the retry button
 * must not be offered. A network or 5xx failure is transient, and the retry is
 * the entire point of the screen.
 */

import { render } from "@testing-library/react-native";

import { ErrorState } from "../components/states/ErrorState";

describe("ErrorState — retry affordance (FE-22)", () => {
  it("offers a retry for a transient failure", () => {
    const { getByTestId } = render(
      <ErrorState message="Indexer unreachable" statusCode={503} onRetry={() => {}} />
    );
    expect(getByTestId("error-state-retry")).toBeTruthy();
  });

  it("hides the retry for a terminal 404", () => {
    const { queryByTestId } = render(
      <ErrorState message="Pool not found" statusCode={404} onRetry={() => {}} showRetry={false} />
    );
    // A button that cannot change the outcome is worse than no button: it
    // teaches the user that retrying is the answer.
    expect(queryByTestId("error-state-retry")).toBeNull();
  });

  it("shows the retry by default", () => {
    const { getByTestId } = render(<ErrorState message="Boom" onRetry={() => {}} />);
    expect(getByTestId("error-state-retry")).toBeTruthy();
  });

  it("still explains the outcome when the retry is hidden", () => {
    const { getByLabelText } = render(
      <ErrorState message="Pool not found" statusCode={404} onRetry={() => {}} showRetry={false} />
    );
    expect(getByLabelText("Not found. Pool not found")).toBeTruthy();
  });
});
