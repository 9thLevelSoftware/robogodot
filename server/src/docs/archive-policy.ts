const MAX_ENTRIES = 20_000;
const MAX_EXPANDED_BYTES = 600_000_000;

export function validateArchiveEntries(entries: Array<{ path: string; size: number }>) {
  if (entries.length > MAX_ENTRIES) throw new Error(`Archive has ${entries.length} entries; maximum is ${MAX_ENTRIES}`);
  let expandedBytes = 0;
  for (const entry of entries) {
    const normalized = entry.path.replaceAll("\\", "/");
    if (normalized.startsWith("/") || /^[a-z]:\//i.test(normalized) || normalized.split("/").includes("..")) throw new Error(`Unsafe archive path '${entry.path}'`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`Invalid archive size for '${entry.path}'`);
    expandedBytes += entry.size;
    if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error(`Archive expands beyond ${MAX_EXPANDED_BYTES} bytes`);
  }
  return { entryCount: entries.length, expandedBytes };
}
