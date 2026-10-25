// Statement limits shared by the public Worker and the admin Worker.
//
// A D1 statement may bind at most 100 parameters, so any query whose `IN (...)`
// list is built from caller data has to be split when that list can get long. The
// batch size below keeps a margin under the ceiling: a statement still has room to
// bind its own values (a timestamp, a status code) beside the list.

export const MAX_BOUND_PARAMS = 90;

// Splits a list into batches small enough to bind in one statement. The caller
// merges the per-batch results, so a long list neither fails nor silently loses
// rows.
export function chunk<T>(items: readonly T[], size: number = MAX_BOUND_PARAMS): T[][] {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new Error('chunk size must be a positive integer');
  }
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}