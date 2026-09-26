/**
 * Daily index aggregation and its persistence (#651).
 *
 * Re-exports the job's public surface and the Postgres store so callers import
 * from one place, matching how the rest of the indexer groups its subsystems.
 */

export {
  AggregationScheduler,
  DEFAULT_CATCH_UP_DAYS,
  DEFAULT_INTERVAL_MS,
  aggregateObservations,
  previousRunDate,
  runDailyAggregation,
  toRunDate,
} from "./job";
export type {
  AggregationOptions,
  AggregationRun,
  AggregationStore,
  IndexAggregate,
  PriceObservation,
  RunStatus,
  RunLogger,
  SchedulerOptions,
  SubmissionStatus,
} from "./job";
export { PostgresAggregationStore, PostgresDeadLetterStore } from "./stores";
