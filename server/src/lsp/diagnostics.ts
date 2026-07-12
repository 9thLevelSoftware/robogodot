import { GodotMcpError } from "../errors.js";
import type { LspNotification } from "./protocol.js";

export const DIAGNOSTIC_LIMITS = { maxUris: 128, maxPerUri: 500, maxMessageBytes: 8_192, maxAuxiliaryStringBytes: 1_024, maxUriBytes: 1_024, maxRelatedInformation: 32, maxWaiters: 128, minWaitMs: 100, maxWaitMs: 15_000 } as const;
export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspRelatedInformation { location: { uri: string; range: LspRange }; message: string }
export interface LspDiagnostic { message: string; range?: LspRange; severity?: number; code?: string | number; source?: string; tags?: number[]; relatedInformation?: LspRelatedInformation[] }
export interface DiagnosticTruncation { diagnostics: boolean; tags: boolean; relatedInformation: boolean; strings: boolean; positions: boolean; malformed: boolean }
export interface DiagnosticSnapshot { uri: string; generation: number; sequence: number; diagnostics: LspDiagnostic[]; fresh: boolean; truncated: boolean; truncation: DiagnosticTruncation }
type Publication = Omit<DiagnosticSnapshot, "fresh">;
type Waiter = { uri: string; generation: number; afterSequence: number; timer: NodeJS.Timeout; resolve(value: DiagnosticSnapshot): void; reject(reason: Error): void };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const own = (value: Record<string, unknown>, key: string): unknown => { try { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && "value" in descriptor ? descriptor.value : undefined; } catch { return undefined; } };
const arrayValues = (value: unknown[], limit: number): { values: unknown[]; omitted: boolean } => { const values: unknown[] = []; let omitted = value.length > limit; for (let index = 0; index < Math.min(value.length, limit); index++) { try { const descriptor = Object.getOwnPropertyDescriptor(value, String(index)); if (descriptor && "value" in descriptor) values.push(descriptor.value); else omitted = true; } catch { omitted = true; } } return { values, omitted }; };
const emptyTruncation = (): DiagnosticTruncation => ({ diagnostics: false, tags: false, relatedInformation: false, strings: false, positions: false, malformed: false });

function truncateUtf8(value: string, limit: number, truncation: DiagnosticTruncation): string {
  const bytes = Buffer.from(value, "utf8"); if (bytes.length <= limit) return value;
  truncation.strings = true;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = limit; end > 0; end--) {
    try { return decoder.decode(bytes.subarray(0, end)); } catch { /* remove an incomplete trailing code point */ }
  }
  return "";
}

function position(value: unknown, truncation: DiagnosticTruncation): LspPosition | undefined {
  if (!isRecord(value)) { truncation.positions = true; return undefined; } const line = own(value, "line"); const character = own(value, "character");
  if (!Number.isInteger(line) || !Number.isInteger(character) || (line as number) < 0 || (character as number) < 0 || (line as number) > 1_000_000 || (character as number) > 1_000_000) { truncation.positions = true; return undefined; }
  return { line: line as number, character: character as number };
}
function range(value: unknown, truncation: DiagnosticTruncation): LspRange | undefined {
  if (!isRecord(value)) return undefined; const start = position(own(value, "start"), truncation); const end = position(own(value, "end"), truncation);
  return start && end ? { start, end } : undefined;
}
function normalize(item: unknown, truncation: DiagnosticTruncation): LspDiagnostic | undefined {
  if (!isRecord(item) || typeof own(item, "message") !== "string") { truncation.malformed = true; return undefined; }
  const result: LspDiagnostic = { message: truncateUtf8(own(item, "message") as string, DIAGNOSTIC_LIMITS.maxMessageBytes, truncation) };
  const rawRange = own(item, "range"); const boundedRange = rawRange === undefined ? undefined : range(rawRange, truncation); if (boundedRange) result.range = boundedRange;
  const severity = own(item, "severity"); if (Number.isInteger(severity) && (severity as number) >= 1 && (severity as number) <= 4) result.severity = severity as number;
  const code = own(item, "code"); if (typeof code === "number" && Number.isFinite(code)) result.code = code;
  else if (typeof code === "string") result.code = truncateUtf8(code, DIAGNOSTIC_LIMITS.maxAuxiliaryStringBytes, truncation);
  const source = own(item, "source"); if (typeof source === "string") result.source = truncateUtf8(source, DIAGNOSTIC_LIMITS.maxAuxiliaryStringBytes, truncation);
  const tags = own(item, "tags"); if (Array.isArray(tags)) { const safeTags = arrayValues(tags, 16); const valid = safeTags.values.filter((tag): tag is number => tag === 1 || tag === 2); if (safeTags.omitted || valid.length !== safeTags.values.length) truncation.tags = true; result.tags = valid; }
  const relatedInformation = own(item, "relatedInformation"); if (Array.isArray(relatedInformation)) {
    const safeRelated = arrayValues(relatedInformation, DIAGNOSTIC_LIMITS.maxRelatedInformation); if (safeRelated.omitted) truncation.relatedInformation = true;
    result.relatedInformation = safeRelated.values.flatMap((related): LspRelatedInformation[] => {
      if (!isRecord(related) || typeof own(related, "message") !== "string" || !isRecord(own(related, "location"))) { truncation.malformed = true; return []; }
      const location = own(related, "location") as Record<string, unknown>; const relatedUri = own(location, "uri");
      if (typeof relatedUri !== "string") { truncation.malformed = true; return []; } const relatedRange = range(own(location, "range"), truncation); if (!relatedRange) { truncation.malformed = true; return []; }
      return [{ location: { uri: truncateUtf8(relatedUri, DIAGNOSTIC_LIMITS.maxUriBytes, truncation), range: relatedRange }, message: truncateUtf8(own(related, "message") as string, DIAGNOSTIC_LIMITS.maxMessageBytes, truncation) }];
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
    if (event.method !== "textDocument/publishDiagnostics" || !isRecord(event.params)) return; const fileUri = own(event.params, "uri"); const source = own(event.params, "diagnostics"); if (typeof fileUri !== "string" || !Array.isArray(source)) return;
    const uri = this.publicUri(fileUri); if (!uri || Buffer.byteLength(uri, "utf8") > DIAGNOSTIC_LIMITS.maxUriBytes) return;
    if (this.closed) return;
    const truncation = emptyTruncation(); const safeDiagnostics = arrayValues(source, DIAGNOSTIC_LIMITS.maxPerUri); if (safeDiagnostics.omitted) truncation.diagnostics = true;
    const diagnostics = safeDiagnostics.values.flatMap((item): LspDiagnostic[] => { const value = normalize(item, truncation); return value ? [value] : []; });
    const publication: Publication = { uri, generation: event.generation, sequence: ++this.sequence, diagnostics, truncated: Object.values(truncation).some(Boolean), truncation };
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
