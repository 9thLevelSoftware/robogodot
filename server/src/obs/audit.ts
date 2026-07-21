export type AuditOutcome = "success" | "error" | "blocked" | "cache_hit";

export interface AuditRecord {
  at: string;
  tool: string;
  mode: string;
  outcome: AuditOutcome;
  code?: string;
  elapsedMs: number;
  mutating: boolean;
  argumentSummary: Record<string, unknown>;
}

export class AuditLog {
  private readonly records: AuditRecord[] = [];
  private readonly maxRecords: number;

  constructor(maxRecords = 1_000) {
    this.maxRecords = maxRecords;
  }

  record(entry: Omit<AuditRecord, "at">): void {
    this.records.push({ ...entry, at: new Date().toISOString() });
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
  }

  list(): readonly AuditRecord[] {
    return this.records;
  }

  clear(): void {
    this.records.length = 0;
  }
}

const SENSITIVE = /source|script|token|password|secret|content|prompt/i;
const MAX_STRING = 120;

export function summarizeArguments(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key === "confirmed") continue;
    if (SENSITIVE.test(key)) {
      out[key] = typeof value === "string" ? `[redacted ${Buffer.byteLength(value, "utf8")} bytes]` : "[redacted]";
      continue;
    }
    out[key] = summarizeValue(value);
  }
  return out;
}

function summarizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (value && typeof value === "object") return { type: "object", keys: Object.keys(value as object).length };
  return value;
}
