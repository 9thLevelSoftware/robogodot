import { describe, expect, it } from "vitest";
import { LspDiagnostics } from "../src/lsp/diagnostics.js";

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
    await expect(store.waitFor(uri, 3, store.sequence, 10)).resolves.toMatchObject({ fresh: false, diagnostics: [] });
  });

  it("ignores malformed notifications and requires matching generation", async () => {
    const store = new LspDiagnostics(() => uri); store.accept({ generation: 3, method: "other" });
    store.accept(notification(2, "file:///project/phase4/broken.gd", [{ message: "old" }]));
    await expect(store.waitFor(uri, 3, store.sequence, 10)).rejects.toMatchObject({ code: "timeout" });
  });

  it("bounds diagnostics, messages, and related information", async () => {
    const store = new LspDiagnostics(() => uri);
    const diagnostics = Array.from({ length: 510 }, () => ({ message: "€".repeat(5_000), relatedInformation: Array.from({ length: 40 }, (_, i) => ({ location: {}, message: String(i) })) }));
    store.accept(notification(4, "file:///project/phase4/broken.gd", diagnostics));
    const snapshot = await store.waitFor(uri, 4, 0, 10);
    expect(snapshot.diagnostics).toHaveLength(500);
    expect(Buffer.byteLength(snapshot.diagnostics[0]!.message)).toBeLessThanOrEqual(8_192);
    expect(snapshot.diagnostics[0]!.relatedInformation).toHaveLength(32);
  });
});
