export type InvalidationTag = "scene" | "signals" | "resources" | "project-settings" | `node:${string}`;

export class MutationLane {
  private tail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(tags: readonly InvalidationTag[]) => void>();

  onInvalidated(listener: (tags: readonly InvalidationTag[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  run<T>(tags: readonly InvalidationTag[], work: () => Promise<T>): Promise<T> {
    const execute = async (): Promise<T> => {
      const value = await work();
      const normalized = [...new Set(tags)].sort();
      for (const listener of this.listeners) listener(normalized);
      return value;
    };
    const result = this.tail.then(execute, execute);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
