import { expect, test } from "vitest";
import { validateArchiveEntries } from "../src/docs/archive-policy.js";

test("rejects traversal, absolute paths, excessive entries, and oversized expansion", () => {
  expect(() => validateArchiveEntries([{ path: "../escape", size: 1 }])).toThrow();
  expect(() => validateArchiveEntries([{ path: "/absolute", size: 1 }])).toThrow();
  expect(() => validateArchiveEntries([{ path: "C:/absolute", size: 1 }])).toThrow();
  expect(() => validateArchiveEntries(Array.from({ length: 20_001 }, (_, index) => ({ path: `safe/${index}`, size: 1 })))).toThrow();
  expect(() => validateArchiveEntries([{ path: "safe/file", size: 600_000_001 }])).toThrow();
  expect(validateArchiveEntries([{ path: "godot/doc/classes/Node.xml", size: 100 }])).toEqual({ entryCount: 1, expandedBytes: 100 });
});
