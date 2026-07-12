import { GodotMcpError } from "../errors.js";
import type { LspNotification } from "./protocol.js";

export const DIAGNOSTIC_LIMITS = { maxUris: 128, maxPerUri: 500, maxMessageBytes: 8_192, maxRelatedInformation: 32 } as const;
export interface LspDiagnostic { message: string; relatedInformation?: unknown[]; [key: string]: unknown }
export interface DiagnosticSnapshot { uri: string; generation: number; sequence: number; diagnostics: LspDiagnostic[]; fresh: boolean }
type Publication = Omit<DiagnosticSnapshot, "fresh">;
type Waiter = { uri: string; generation: number; afterSequence: number; resolve(value: DiagnosticSnapshot): void };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function truncateUtf8(value: string, limit: number): string {
  const bytes = Buffer.from(value, "utf8"); if (bytes.length <= limit) return value;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = limit; end > 0; end--) {
    try { return decoder.decode(bytes.subarray(0, end)); } catch { /* remove an incomplete trailing code point */ }
  }
  return "";
}

export class LspDiagnostics {
  sequence = 0;
  private readonly publications = new Map<string, Publication>();
  private readonly waiters = new Set<Waiter>();
  constructor(private readonly publicUri: (fileUri: string) => string | undefined = (uri) => uri) {}

  accept(event: LspNotification): void {
    if (event.method !== "textDocument/publishDiagnostics" || !isRecord(event.params) || typeof event.params.uri !== "string" || !Array.isArray(event.params.diagnostics)) return;
    const uri = this.publicUri(event.params.uri); if (!uri) return;
    const diagnostics = event.params.diagnostics.slice(0, DIAGNOSTIC_LIMITS.maxPerUri).flatMap((item): LspDiagnostic[] => {
      if (!isRecord(item) || typeof item.message !== "string") return [];
      const bounded: LspDiagnostic = { ...item, message: truncateUtf8(item.message, DIAGNOSTIC_LIMITS.maxMessageBytes) };
      if (Array.isArray(item.relatedInformation)) bounded.relatedInformation = item.relatedInformation.slice(0, DIAGNOSTIC_LIMITS.maxRelatedInformation);
      return [bounded];
    });
    const publication: Publication = { uri, generation: event.generation, sequence: ++this.sequence, diagnostics };
    if (!this.publications.has(uri) && this.publications.size >= DIAGNOSTIC_LIMITS.maxUris) this.publications.delete(this.publications.keys().next().value as string);
    this.publications.delete(uri); this.publications.set(uri, publication);
    for (const waiter of [...this.waiters]) if (waiter.uri === uri && waiter.generation === event.generation && publication.sequence > waiter.afterSequence) {
      this.waiters.delete(waiter); waiter.resolve({ ...publication, fresh: true });
    }
  }

  waitFor(uri: string, generation: number, afterSequence: number, waitMs: number): Promise<DiagnosticSnapshot> {
    if (!Number.isInteger(generation) || generation < 1 || !Number.isInteger(afterSequence) || afterSequence < 0 || !Number.isFinite(waitMs) || waitMs < 0) return Promise.reject(new GodotMcpError("invalid_args", "Invalid diagnostics wait parameters.", "Use a current generation, sequence, and finite non-negative wait."));
    const current = this.publications.get(uri);
    if (current?.generation === generation && current.sequence > afterSequence) return Promise.resolve({ ...current, fresh: true });
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { uri, generation, afterSequence, resolve: (value) => { clearTimeout(timer); resolve(value); } }; this.waiters.add(waiter);
      const timer = setTimeout(() => {
        this.waiters.delete(waiter); const cached = this.publications.get(uri);
        if (cached?.generation === generation) resolve({ ...cached, fresh: false });
        else reject(new GodotMcpError("timeout", "Timed out waiting for diagnostics.", "Retry after the language server publishes diagnostics."));
      }, waitMs);
    });
  }
}
