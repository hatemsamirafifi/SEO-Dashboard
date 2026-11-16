export { parseUtcTimestampMs } from "@/shared/rank-tracking";

export function toSqliteTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}
