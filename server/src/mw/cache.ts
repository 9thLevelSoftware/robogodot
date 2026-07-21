export class ReadCache {
  private generation = 0;
  private readonly store = new Map<string, { value: unknown; generation: number; tags: string[]; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: { ttlMs?: number; maxEntries?: number } = {}) {
    this.ttlMs = options.ttlMs ?? 5_000;
    this.maxEntries = options.maxEntries ?? 256;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  beginMutation(_tags: readonly string[]): number {
    this.generation += 1;
    this.invalidate(_tags);
    return this.generation;
  }

  endMutation(_startGeneration: number, tags: readonly string[]): void {
    this.invalidate(tags);
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now() || entry.generation !== this.generation) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set(key: string, value: unknown, tags: readonly string[], generation: number): void {
    if (generation !== this.generation) return;
    if (this.store.size >= this.maxEntries) {
      const first = this.store.keys().next().value;
      if (first !== undefined) this.store.delete(first);
    }
    this.store.set(key, {
      value,
      generation,
      tags: [...tags],
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  invalidate(tags: readonly string[]): void {
    if (tags.includes("*")) {
      this.store.clear();
      return;
    }
    const doomed = new Set(tags);
    for (const [key, entry] of this.store) {
      if (entry.tags.includes("*") || entry.tags.some((tag) => doomed.has(tag))) {
        this.store.delete(key);
      }
    }
  }

  clear(): void {
    this.store.clear();
  }
}

export function cacheKey(toolName: string, input: unknown): string {
  return `${toolName}:${stableStringify(input)}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (key === "confirmed") continue;
      sorted[key] = sortValue(record[key]);
    }
    return sorted;
  }
  return value;
}
