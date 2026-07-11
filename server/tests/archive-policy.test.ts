import { expect, test } from "vitest";
import { gzipSync } from "node:zlib";
import { inspectTarGz, validateArchiveEntries } from "../src/docs/archive-policy.js";

test("rejects traversal, absolute paths, excessive entries, and oversized expansion", () => {
  expect(() => validateArchiveEntries([{ path: "../escape", size: 1 }])).toThrow();
  expect(() => validateArchiveEntries([{ path: "/absolute", size: 1 }])).toThrow();
  expect(() => validateArchiveEntries([{ path: "C:/absolute", size: 1 }])).toThrow();
  expect(() => validateArchiveEntries(Array.from({ length: 20_001 }, (_, index) => ({ path: `safe/${index}`, size: 1 })))).toThrow();
  expect(() => validateArchiveEntries([{ path: "safe/file", size: 600_000_001 }])).toThrow();
  expect(validateArchiveEntries([{ path: "godot/doc/classes/Node.xml", size: 100 }])).toEqual({ entryCount: 1, expandedBytes: 100 });
});

function declaredTarHeader(path: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = [...header].reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));
}

test("rejects oversized declared tar totals during preflight", async () => {
  await expect(inspectTarGz(declaredTarHeader("safe/huge.xml", 600_000_001))).rejects.toThrow(/expands beyond/);
});
