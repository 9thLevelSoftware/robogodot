import { describe, expect, it } from "vitest";
import { OutputRing } from "../src/runtime/output-ring.js";

describe("OutputRing", () => {
  it("reports overwritten records without changing cursor meaning", () => {
    const ring = new OutputRing({ maxRecords: 3, maxBytes: 64, maxLineBytes: 16 });
    for (const text of ["one\n", "two\n", "three\n", "four\n"]) ring.append("stdout", Buffer.from(text));
    expect(ring.read(0, 10)).toMatchObject({
      records: [{ cursor: 1, text: "two" }, { cursor: 2, text: "three" }, { cursor: 3, text: "four" }],
      next: 4, lost: 1, truncated: false,
    });
  });

  it("decodes split UTF-8 chunks and normalizes only line terminators", () => {
    const ring = new OutputRing();
    const bytes = Buffer.from("héllo\r\nembedded\rtext\n");
    ring.append("stdout", bytes.subarray(0, 2), 10);
    ring.append("stdout", bytes.subarray(2), 11);
    expect(ring.read(0, 10).records).toEqual([
      { cursor: 0, stream: "stdout", at: 11, text: "héllo", truncated: false },
      { cursor: 1, stream: "stdout", at: 11, text: "embedded\rtext", truncated: false },
    ]);
  });

  it("keeps partial lines independent and flushes them on exit", () => {
    const ring = new OutputRing();
    ring.append("stdout", Buffer.from("out"), 1);
    ring.append("stderr", Buffer.from("err"), 2);
    ring.finish("stderr", 3);
    ring.finish("stdout", 4);
    expect(ring.read(0, 10).records).toEqual([
      { cursor: 0, stream: "stderr", at: 3, text: "err", truncated: false },
      { cursor: 1, stream: "stdout", at: 4, text: "out", truncated: false },
    ]);
  });

  it("bounds an unterminated line and marks invalid or oversized UTF-8", () => {
    const ring = new OutputRing({ maxRecords: 10, maxBytes: 100, maxLineBytes: 4 });
    ring.append("stdout", Buffer.from("abcdef"));
    ring.append("stdout", Buffer.from([0xff, 0x0a]));
    expect(ring.read(0, 10).records).toEqual([
      expect.objectContaining({ text: "abcd", truncated: true }),
    ]);
  });

  it("evicts whole records to satisfy the retained byte bound", () => {
    const ring = new OutputRing({ maxRecords: 10, maxBytes: 5, maxLineBytes: 10 });
    ring.append("stdout", Buffer.from("abc\nde\nf\n"));
    expect(ring.read(0, 10)).toMatchObject({
      records: [{ cursor: 1, text: "de" }, { cursor: 2, text: "f" }], lost: 1,
    });
  });

  it("validates cursors and page sizes and reports page truncation", () => {
    const ring = new OutputRing();
    ring.append("stdout", Buffer.from("a\nb\nc\n"));
    expect(() => ring.read(-1, 1)).toThrow(/since/);
    expect(() => ring.read(0.5, 1)).toThrow(/since/);
    expect(() => ring.read(0, 0)).toThrow(/limit/);
    expect(() => ring.read(0, 501)).toThrow(/limit/);
    expect(ring.read(0, 2)).toMatchObject({ next: 2, lost: 0, truncated: true });
    expect(ring.read(99, 10)).toMatchObject({ records: [], next: 3, lost: 0, truncated: false });
  });
});
