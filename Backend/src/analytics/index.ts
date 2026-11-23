/**
 * Public surface of the index analytics module.
 *
 * Issues #652-#655. Re-exported in one place so callers depend on
 * `../analytics` rather than reaching into individual files, and so the
 * package boundary is visible in one import.
 */

export {
  aggregate,
  median,
  quartile,
  medianAbsoluteDeviation,
  weightedMean,
  credibilityWeights,
  FILTER_REASONS,
} from "./index-aggregation";
export type {
  AggregationResult,
  FilterDecision,
  FilterOptions,
  FilterReason,
  PricePoint,
} from "./index-aggregation";

export {
  PostgresAnalyticsStore,
  QueryValidationError,
  parseCountryIso,
  parsePagination,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
} from "./store";
export type {
  FilterDecisionView,
  HistoryQuery,
  IndexHistoryEntry,
  IndexHistoryPage,
  LeaderboardEntry,
  LeaderboardPage,
  LeaderboardScope,
} from "./store";

export { runDailyIndexAggregation, previousUtcDay } from "./job";
export type { DailyAggregationOptions, DailyAggregationResult } from "./job";

export { createIndexRouter } from "./routes";
