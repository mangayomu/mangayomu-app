/** Returns an explicitly requested, valid zero-based Reader page, or null. */
export function requestedReaderPageIndex(value, totalPages) {
  if (value === undefined || value === null || value === "") return null;
  const pageIndex = Number(value);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= totalPages) return null;
  return pageIndex;
}
