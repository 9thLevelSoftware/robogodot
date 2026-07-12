import { GodotMcpError } from "../errors.js";
import type { LspNotification } from "./protocol.js";

export const DIAGNOSTIC_LIMITS = { maxUris: 128, maxPerUri: 500, maxMessageBytes: 8_192, maxAuxiliaryStringBytes: 1_024, maxUriBytes: 1_024, maxRelatedInformation: 32, maxWaiters: 128, minWaitMs: 100, maxWaitMs: 15_000 } as const;
export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspRelatedInformation { location: { uri: string; range: LspRange }; message: string }
export interface LspDiagnostic { message: string; range?: LspRange; severity?: number; code?: string | number; source?: string; tags?: number[]; relatedInformation?: LspRelatedInformation[] }
export interface DiagnosticSnapshot { uri: string; generation: number; sequence: number; diagnostics: LspDiagnostic[]; fresh: boolean }
type Publication = Omit<DiagnosticSnapshot, "fresh">;
type Waiter = { uri: string; generation: number; afterSequence: number; timer: NodeJS.Timeout; resolve(value: DiagnosticSnapshot): void; reject(reason: Error): void };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function truncateUtf8(value: string, limit: number): string {
  const bytes = Buffer.from(value, "utf8"); if (bytes.length <= limit) return value;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = limit; end > 0; end--) {
    try { return decoder.decode(bytes.subarray(0, end)); } catch { /* remove an incomplete trailing code point */ }
  }
  return "";
}

function position(value: unknown): LspPosition | undefined {
  if (!isRecord(value) || !Number.isInteger(value.line) || !Number.isInteger(value.character) || (value.line as number) < 0 || (value.character as number) < 0) return undefined;
  return { line: value.line as number, character: value.character as number };
}
function range(value: unknown): LspRange | undefined {
  if (!isRecord(value)) return undefined; const start = position(value.start); const end = position(value.end);
  return start && end ? { start, end } : undefined;
}
function normalize(item: unknown): LspDiagnostic | undefined {
  if (!isRecord(item) || typeof item.message !== "string") return undefined;
  const result: LspDiagnostic = { message: truncateUtf8(item.message, DIAGNOSTIC_LIMITS.maxMessageBytes) };
  const boundedRange = range(item.range); if (boundedRange) result.range = boundedRange;
  if (Number.isInteger(item.severity) && (item.severity as number) >= 1 && (item.severity as number) <= 4) result.severity = item.severity as number;
  if (typeof item.code === "number" && Number.isFinite(item.code)) result.code = item.code;
  else if (typeof item.code === "string") result.code = truncateUtf8(item.code, DIAGNOSTIC_LIMITS.maxAuxiliaryStringBytes);
  if (typeof item.source === "string") result.source = truncateUtf8(item.source, DIAGNOSTIC_LIMITS.maxAuxiliaryStringBytes);
  if (Array.isArray(item.tags)) result.tags = item.tags.filter((tag): tag is number => tag === 1 || tag === 2).slice(0, 16);
  if (Array.isArray(item.relatedInformation)) {
    result.relatedInformation = item.relatedInformation.slice(0, DIAGNOSTIC_LIMITS.maxRelatedInformation).flatMap((related): LspRelatedInformation[] => {
      if (!isRecord(related) || typeof related.message !== "string" || !isRecord(related.location) || typeof related.location.uri !== "string") return [];
      const relatedRange = range(related.location.range); if (!relatedRange) return [];
      return [{ location: { uri: truncateUtf8(related.location.uri, DIAGNOSTIC_LIMITS.maxUriBytes), range: relatedRange }, message: truncateUtf8(related.message, DIAGNOSTIC_LIMITS.maxMessageBytes) }];
    });
  }
  return result;
}

export class LspDiagnostics {
  sequence = 0;
  private readonly publications = new Map<string, Publication>();
  private readonly waiters = new Set<Waiter>();
  private closed = false;
  constructor(private readonly publicUri: (fileUri: string) => string | undefined = (uri) => uri) {}

  accept(event: LspNotification): void {
    if (event.method !== "textDocument/publishDiagnostics" || !isRecord(event.params) || typeof event.params.uri !== "string" || !Array.isArray(event.params.diagnostics)) return;
    const uri = this.publicUri(event.params.uri); if (!uri || Buffer.byteLength(uri, "utf8") > DIAGNOSTIC_LIMITS.maxUriBytes) return;
    if (this.closed) return;
    const diagnostics = event.params.diagnostics.slice(0, DIAGNOSTIC_LIMITS.maxPerUri).flatMap((item): LspDiagnostic[] => { const value = normalize(item); return value ? [value] : []; });
    const publication: Publication = { uri, generation: event.generation, sequence: ++this.sequence, diagnostics };
    if (!this.publications.has(uri) && this.publications.size >= DIAGNOSTIC_LIMITS.maxUris) this.publications.delete(this.publications.keys().next().value as string);
    this.publications.delete(uri); this.publications.set(uri, publication);
    for (const waiter of [...this.waiters]) if (waiter.uri === uri && waiter.generation === event.generation && publication.sequence > waiter.afterSequence) {
      this.waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve({ ...publication, fresh: true });
    }
  }

  waitFor(uri: string, generation: number, afterSequence: number, waitMs: number): Promise<DiagnosticSnapshot> {
    if (typeof uri !== "string" || uri.length === 0 || Buffer.byteLength(uri, "utf8") > DIAGNOSTIC_LIMITS.maxUriBytes) return Promise.reject(new GodotMcpError("invalid_args", "Invalid diagnostics URI.", `Use a nonempty URI of at most ${DIAGNOSTIC_LIMITS.maxUriBytes} UTF-8 bytes.`));
    if (this.closed) return Promise.reject(new GodotMcpError("not_connected", "Diagnostics store is closed.", "Create a new LSP client before waiting for diagnostics."));
    if (!Number.isInteger(generation) || generation < 1 || !Number.isInteger(afterSequence) || afterSequence < 0 || !Number.isInteger(waitMs) || waitMs < DIAGNOSTIC_LIMITS.minWaitMs || waitMs > DIAGNOSTIC_LIMITS.maxWaitMs) return Promise.reject(new GodotMcpError("invalid_args", "Invalid diagnostics wait parameters.", `Use a wait from ${DIAGNOSTIC_LIMITS.minWaitMs} to ${DIAGNOSTIC_LIMITS.maxWaitMs} milliseconds.`));
    const current = this.publications.get(uri);
    if (current?.generation === generation && current.sequence > afterSequence) return Promise.resolve({ ...current, fresh: true });
    if (this.waiters.size >= DIAGNOSTIC_LIMITS.maxWaiters) return Promise.reject(new GodotMcpError("godot_error", "Diagnostics waiter limit reached.", "Wait for an existing diagnostics request to finish."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter); const cached = this.publications.get(uri);
        if (cached?.generation === generation) resolve({ ...cached, fresh: false });
        else reject(new GodotMcpError("timeout", "Timed out waiting for diagnostics.", "Retry after the language server publishes diagnostics."));
      }, waitMs);
      const waiter: Waiter = { uri, generation, afterSequence, timer, resolve, reject }; this.waiters.add(waiter);
    });
  }

  close(reason: Error = new GodotMcpError("not_connected", "Diagnostics store is closed.", "Create a new LSP client before waiting for diagnostics.")): void {
    if (this.closed) return; this.closed = true;
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(reason); }
    this.waiters.clear(); this.publications.clear(); this.sequence = 0;
  }
}
