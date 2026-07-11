import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logger.js";

describe("createLogger", () => {
  it("writes structured JSON records to its stderr sink", () => {
    const records: string[] = [];
    createLogger("info", (line) => records.push(line)).info("ready", { port: 9200 });
    const record = JSON.parse(records[0]!);
    expect(record).toMatchObject({ level: "info", message: "ready", port: 9200 });
    expect(new Date(record.timestamp).toISOString()).toBe(record.timestamp);
  });

  it("filters debug records unless DEBUG logging is enabled", () => {
    const records: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write");
    createLogger("info", (line) => records.push(line)).debug("hidden");
    createLogger("debug", (line) => records.push(line)).debug("shown");
    expect(records).toHaveLength(1);
    expect(stdout).not.toHaveBeenCalled();
    stdout.mockRestore();
  });
});
