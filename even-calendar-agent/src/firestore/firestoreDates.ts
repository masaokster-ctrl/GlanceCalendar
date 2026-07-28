import { Timestamp } from '@google-cloud/firestore';

/**
 * FirestoreはDate値をTimestampとして返す(getTime()を持たない)ため、
 * 読み取り側の型(Date)と実際のランタイム型を一致させてから返す。既存の各repositoryに
 * 重複していた同等ロジックをPhase 2H新設repository群向けに共通化したもの。
 */
export function normalizeDate(value: unknown): Date {
  if (value instanceof Timestamp) return value.toDate();
  return value as Date;
}

export function normalizeNullableDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return normalizeDate(value);
}
