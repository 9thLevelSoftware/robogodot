import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";

const probes = (files: string[] = [], executables: string[] = []) => ({
  pathValue: "C:\\Tools;C:\\Godot",
  isFile: (candidate: string) => files.includes(candidate),
  isExecutable: (candidate: string) => executables.includes(candidate),
});
const TOKEN_ENV = { GODOT_MCP_TOKEN: "0123456789abcdef0123456789abcdef" };

describe("resolveConfig", () => {
  it("uses the exact foundation defaults", () => {
    expect(resolveConfig({ GODOT_MCP_TOKEN: "0123456789abcdef0123456789abcdef" }, "C:\\repo", "win32", probes())).toEqual({
      editorHost: "127.0.0.1", editorPort: 9200, lspPort: 6005, dapPort: 6006,
      mode: "full", debug: false, token: "0123456789abcdef0123456789abcdef",
    });
  });

  it.each([undefined, "", "too-short"])("rejects a missing or low-entropy token: %s", (token) => {
    expect(() => resolveConfig(token === undefined ? {} : { GODOT_MCP_TOKEN: token }, "C:\\repo", "win32", probes()))
      .toThrow(/GODOT_MCP_TOKEN/);
  });

  it("applies environment overrides", () => {
    const config = resolveConfig({ ...TOKEN_ENV, GODOT_MCP_PORT: "9300", GODOT_LSP_PORT: "7005", GODOT_DAP_PORT: "7006", GODOT_MCP_MODE: "read_only", DEBUG: "true", GODOT_PROJECT_PATH: "C:\\game" }, "C:\\repo", "win32", probes());
    expect(config).toMatchObject({ editorPort: 9300, lspPort: 7005, dapPort: 7006, mode: "read_only", debug: true, projectPath: "C:\\game" });
  });

  it("finds the nearest parent containing project.godot", () => {
    const projectFile = path.win32.normalize("C:\\repo\\game\\project.godot");
    expect(resolveConfig(TOKEN_ENV, "C:\\repo\\game\\src", "win32", probes([projectFile])).projectPath).toBe(path.win32.normalize("C:\\repo\\game"));
  });

  it("prefers explicit GODOT_PATH", () => {
    const injected = probes();
    injected.isExecutable = () => { throw new Error("discovery should not run"); };
    expect(resolveConfig({ ...TOKEN_ENV, GODOT_PATH: "C:\\custom\\godot.exe" }, "C:\\repo", "win32", injected).godotPath).toBe("C:\\custom\\godot.exe");
  });

  it("discovers Windows executable candidates from PATH", () => {
    const executable = path.win32.normalize("C:\\Godot\\godot4_console.exe");
    expect(resolveConfig(TOKEN_ENV, "C:\\repo", "win32", probes([], [executable])).godotPath).toBe(executable);
  });

  it("uses the target platform delimiter when resolving a Unix PATH on Windows", () => {
    const executable = path.posix.normalize("/opt/godot/bin/godot4");
    const injected = {
      pathValue: "/usr/local/bin:/opt/godot/bin",
      isFile: () => false,
      isExecutable: (candidate: string) => candidate === executable,
    };
    expect(resolveConfig(TOKEN_ENV, "/repo", "linux", injected).godotPath).toBe(executable);
  });

  it("uses Unix parent traversal when resolving a Unix project on Windows", () => {
    const projectFile = path.posix.normalize("/repo/game/project.godot");
    const injected = {
      pathValue: "",
      isFile: (candidate: string) => candidate === projectFile,
      isExecutable: () => false,
    };
    expect(resolveConfig(TOKEN_ENV, "/repo/game/src", "linux", injected).projectPath).toBe(path.posix.normalize("/repo/game"));
  });

  it.each(["0", "65536", "2.5", "nope"])("rejects invalid port %s", (value) => {
    expect(() => resolveConfig({ ...TOKEN_ENV, GODOT_MCP_PORT: value }, "C:\\repo", "win32", probes())).toThrow(/GODOT_MCP_PORT/);
  });

  it("rejects an invalid mode", () => {
    expect(() => resolveConfig({ ...TOKEN_ENV, GODOT_MCP_MODE: "unsafe" }, "C:\\repo", "win32", probes())).toThrow(/GODOT_MCP_MODE/);
  });
});
