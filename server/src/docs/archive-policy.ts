import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import tar from "tar-stream";

export const MAX_ARCHIVE_ENTRIES = 20_000;
export const MAX_EXPANDED_BYTES = 600_000_000;

function validatePath(path: string): void {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-z]:\//i.test(normalized) || normalized.split("/").includes("..")) throw new Error(`Unsafe archive path '${path}'`);
}

export function validateArchiveEntries(entries: Array<{ path: string; size: number }>) {
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error(`Archive has ${entries.length} entries; maximum is ${MAX_ARCHIVE_ENTRIES}`);
  let expandedBytes = 0;
  for (const entry of entries) {
    validatePath(entry.path);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`Invalid archive size for '${entry.path}'`);
    expandedBytes += entry.size;
    if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error(`Archive expands beyond ${MAX_EXPANDED_BYTES} bytes`);
  }
  return { entryCount: entries.length, expandedBytes };
}

export function inspectTarGz(compressed: Buffer): Promise<{ entryCount: number; expandedBytes: number }> {
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    const gunzip = createGunzip();
    const source = Readable.from(compressed);
    let entryCount = 0;
    let expandedBytes = 0;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      source.destroy(); gunzip.destroy(); extract.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    extract.on("entry", (header, stream, next) => {
      try {
        entryCount++;
        if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error(`Archive has more than ${MAX_ARCHIVE_ENTRIES} entries`);
        validatePath(header.name);
        if (header.type !== "file" && header.type !== "directory") throw new Error(`Unsupported archive entry type '${header.type}' for '${header.name}'`);
        const size = header.type === "file" ? header.size ?? 0 : 0;
        if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid archive size for '${header.name}'`);
        expandedBytes += size;
        if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error(`Archive expands beyond ${MAX_EXPANDED_BYTES} bytes`);
        stream.on("error", fail);
        stream.on("end", next);
        stream.resume();
      } catch (error) { fail(error); }
    });
    extract.on("finish", () => { if (!settled) { settled = true; resolve({ entryCount, expandedBytes }); } });
    extract.on("error", fail); gunzip.on("error", fail); source.on("error", fail);
    source.pipe(gunzip).pipe(extract);
  });
}
