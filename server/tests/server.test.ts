import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";

describe("createServer", () => {
  it("identifies as godot-control-mcp version 0.1.0", () => {
    const server = createServer({});
    expect((server.server as unknown as { _serverInfo: unknown })._serverInfo).toEqual({ name: "godot-control-mcp", version: "0.1.0" });
  });

  it("writes nothing to stdout during construction", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      createServer({});
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });
});
