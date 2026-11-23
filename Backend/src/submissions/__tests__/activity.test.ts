import { PostgresActivityFeed } from "../activity";

describe("PostgresActivityFeed", () => {
  it("combines contributor submissions and votes into a stable newest-first page", async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ total: "3" }] })
      .mockResolvedValueOnce({ rows: [
        { id: "vote:s1:Gvoter", kind: "vote", occurred_at: "2026-01-02T00:00:00Z", submission_id: "s1", details: { verdict: "approve" } },
        { id: "submission:s2", kind: "submission", occurred_at: "2026-01-01T00:00:00Z", submission_id: "s2", details: { status: "pending", value: "500" } },
      ] });
    const feed = new PostgresActivityFeed({ query } as never);
    const page = await feed.list(`G${"A".repeat(55)}`, 2, 0);

    expect(page.activities.map((item) => item.kind)).toEqual(["vote", "submission"]);
    expect(page.total).toBe(3);
    expect(page.hasMore).toBe(true);
    expect(query.mock.calls[1][0]).toContain("ORDER BY occurred_at DESC, kind ASC, id ASC");
    expect(query.mock.calls[1][1]).toEqual([`G${"A".repeat(55)}`, 2, 0]);
  });
});
