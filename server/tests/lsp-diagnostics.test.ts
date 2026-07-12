import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_LIMITS, LspDiagnostics } from "../src/lsp/diagnostics.js";
import { LspClient } from "../src/lsp/client.js";
import { LspSession } from "../src/lsp/session.js";

const uri = "res://phase4/broken.gd";
const notification = (generation: number, fileUri: string, diagnostics: unknown[]) => ({ generation, method: "textDocument/publishDiagnostics", params: { uri: fileUri, diagnostics } });

describe("LspDiagnostics", () => {
  it("returns the first publication after the synchronized sequence as fresh", async () => {
    const store = new LspDiagnostics((value) => value === "file:///project/phase4/broken.gd" ? uri : undefined);
    const waiting = store.waitFor(uri, 3, store.sequence, 1_000);
    store.accept(notification(3, "file:///project/phase4/broken.gd", [{ message: "Identifier not declared", severity: 1 }]));
    await expect(waiting).resolves.toMatchObject({ fresh: true, diagnostics: [{ message: "Identifier not declared" }] });
  });

  it("returns a bounded cached publication as stale when a fresh wait expires", async () => {
    const store = new LspDiagnostics(() => uri); store.accept(notification(3, "file:///project/phase4/broken.gd", []));
    await expect(store.waitFor(uri, 3, store.sequence, DIAGNOSTIC_LIMITS.minWaitMs)).resolves.toMatchObject({ fresh: false, diagnostics: [] });
  });

  it("ignores malformed notifications and requires matching generation", async () => {
    const store = new LspDiagnostics(() => uri); store.accept({ generation: 3, method: "other" });
    store.accept(notification(2, "file:///project/phase4/broken.gd", [{ message: "old" }]));
    await expect(store.waitFor(uri, 3, store.sequence, DIAGNOSTIC_LIMITS.minWaitMs)).rejects.toMatchObject({ code: "timeout" });
  });

  it("bounds diagnostics, messages, and related information", async () => {
    const store = new LspDiagnostics(() => uri);
    const diagnostics = Array.from({ length: 510 }, () => ({ message: "€".repeat(5_000), relatedInformation: Array.from({ length: 40 }, (_, i) => ({ location: { uri: "file:///project/source.gd", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }, message: String(i) })) }));
    store.accept(notification(4, "file:///project/phase4/broken.gd", diagnostics));
    const snapshot = await store.waitFor(uri, 4, 0, DIAGNOSTIC_LIMITS.minWaitMs);
    expect(snapshot.diagnostics).toHaveLength(500);
    expect(Buffer.byteLength(snapshot.diagnostics[0]!.message)).toBeLessThanOrEqual(8_192);
    expect(snapshot.diagnostics[0]!.relatedInformation).toHaveLength(32);
    expect(snapshot).toMatchObject({ truncated: true, truncation: { diagnostics: true, relatedInformation: true, strings: true } });
  });

  it("declares tag, malformed, and out-of-public-range position omissions", async () => {
    const store = new LspDiagnostics(() => uri);
    store.accept(notification(4, "file:///project/phase4/broken.gd", [
      { message: "problem", tags: [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1], range: { start: { line: 1_000_001, character: 0 }, end: { line: 0, character: 1 } } },
      { severity: 1 },
    ]));
    const snapshot = await store.waitFor(uri, 4, 0, DIAGNOSTIC_LIMITS.minWaitMs);
    expect(snapshot.diagnostics[0]).not.toHaveProperty("range");
    expect(snapshot).toMatchObject({ truncated: true, truncation: { tags: true, positions: true, malformed: true } });
  });

  it("does not execute array length getters while normalizing diagnostics", () => {
    let lengthGets = 0; const diagnostics = new Proxy([{ message: "problem" }], { get: (target, key, receiver) => { if (key === "length") { lengthGets++; throw new Error("length getter"); } return Reflect.get(target, key, receiver); } });
    const store = new LspDiagnostics(() => uri);
    expect(() => store.accept(notification(4, "file:///project/phase4/broken.gd", diagnostics))).not.toThrow();
    expect(lengthGets).toBe(0);
  });

  it("rejects waits outside the named finite deadline bounds", async () => {
    const store = new LspDiagnostics(() => uri);
    await expect(store.waitFor(uri, 3, 0, DIAGNOSTIC_LIMITS.minWaitMs - 1)).rejects.toMatchObject({ code: "invalid_args" });
    await expect(store.waitFor(uri, 3, 0, DIAGNOSTIC_LIMITS.maxWaitMs + 1)).rejects.toMatchObject({ code: "invalid_args" });
  });

  it("accepts a caller URI at the exact UTF-8 byte boundary", async () => {
    const store = new LspDiagnostics(); const boundary = "é".repeat(DIAGNOSTIC_LIMITS.maxUriBytes / 2);
    const waiting = expect(store.waitFor(boundary, 3, 0, DIAGNOSTIC_LIMITS.maxWaitMs)).rejects.toMatchObject({ code: "not_connected" });
    store.close(); await waiting;
  });

  it("rejects a caller URI above the UTF-8 byte boundary without retaining a waiter", async () => {
    const store = new LspDiagnostics(); const oversized = `${"é".repeat(DIAGNOSTIC_LIMITS.maxUriBytes / 2)}x`;
    const rejected = store.waitFor(oversized, 3, 0, DIAGNOSTIC_LIMITS.maxWaitMs).then(() => "resolved", (error: { code?: string }) => error.code);
    const waits = Array.from({ length: DIAGNOSTIC_LIMITS.maxWaiters }, (_, i) => store.waitFor(`res://bounded-${i}.gd`, 3, 0, DIAGNOSTIC_LIMITS.maxWaitMs).then(() => "resolved", (error: { code?: string }) => error.code));
    store.close(); expect(await rejected).toBe("invalid_args"); expect(await Promise.all(waits)).toEqual(Array(DIAGNOSTIC_LIMITS.maxWaiters).fill("not_connected"));
  });

  it("fails closed at the concurrent waiter cap and close rejects all waiters idempotently", async () => {
    const store = new LspDiagnostics(() => uri);
    store.accept(notification(3, "file:///project/phase4/broken.gd", []));
    const waits = Array.from({ length: DIAGNOSTIC_LIMITS.maxWaiters }, (_, i) => expect(store.waitFor(`${uri}?${i}`, 3, 0, DIAGNOSTIC_LIMITS.maxWaitMs)).rejects.toMatchObject({ code: "not_connected" }));
    await expect(store.waitFor("res://overflow.gd", 3, 0, DIAGNOSTIC_LIMITS.maxWaitMs)).rejects.toMatchObject({ code: "godot_error" });
    store.close(); store.close();
    expect(store.sequence).toBe(0);
    await Promise.all(waits);
    await expect(store.waitFor(uri, 3, 0, DIAGNOSTIC_LIMITS.minWaitMs)).rejects.toMatchObject({ code: "not_connected" });
  });

  it("normalizes nested diagnostics and drops arbitrary retained payloads", async () => {
    const store = new LspDiagnostics(() => uri);
    store.accept(notification(5, "file:///project/phase4/broken.gd", [{
      message: "problem", severity: 1, tags: [1, 2, 999], code: "x".repeat(10_000), source: "s".repeat(10_000), unknown: { huge: "x".repeat(100_000) },
      range: { start: { line: 1, character: 2, extra: "drop" }, end: { line: 3, character: 4 } },
      relatedInformation: [{ location: { uri: `file:///${"u".repeat(10_000)}`, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, unknown: "drop" }, message: "€".repeat(5_000), unknown: "drop" }],
    }]));
    const diagnostic = (await store.waitFor(uri, 5, 0, DIAGNOSTIC_LIMITS.minWaitMs)).diagnostics[0]!;
    expect(diagnostic).toEqual(expect.objectContaining({ message: "problem", severity: 1, range: { start: { line: 1, character: 2 }, end: { line: 3, character: 4 } } }));
    expect(diagnostic).not.toHaveProperty("unknown");
    expect(diagnostic.tags).toEqual([1, 2]);
    expect(Buffer.byteLength(String(diagnostic.code))).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.maxAuxiliaryStringBytes);
    expect(Buffer.byteLength(String(diagnostic.source))).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.maxAuxiliaryStringBytes);
    expect(Buffer.byteLength(diagnostic.relatedInformation![0]!.location.uri)).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.maxUriBytes);
    expect(Buffer.byteLength(diagnostic.relatedInformation![0]!.message)).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.maxMessageBytes);
    expect(JSON.stringify(diagnostic)).not.toContain("huge");
  });

  it("does not retain an oversized publication URI", () => {
    const store = new LspDiagnostics();
    store.accept(notification(5, `file:///${"x".repeat(DIAGNOSTIC_LIMITS.maxUriBytes + 1)}`, [{ message: "problem" }]));
    expect(store.sequence).toBe(0);
  });

  it("client close rejects pending diagnostics waits before closing the session", async () => {
    const session = new LspSession({ host: "127.0.0.1", port: 1, projectRootUri: "file:///project" });
    const client = new LspClient(process.cwd(), session);
    const pending = client.diagnostics.waitFor(uri, 1, 0, DIAGNOSTIC_LIMITS.maxWaitMs);
    await client.close();
    await expect(pending).rejects.toMatchObject({ code: "not_connected" });
  });
});
