import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HeadlessRunner } from "../src/batch/headless.js";

function child(exitCode = 0) {
  const value = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn>; pid: number };
  value.stdout = new EventEmitter();
  value.stderr = new EventEmitter();
  value.kill = vi.fn();
  value.pid = 4242;
  setTimeout(() => {
    value.stdout.emit("data", Buffer.from("hello-headless\n"));
    value.emit("exit", exitCode);
  }, 0);
  return value;
}

describe("HeadlessRunner", () => {
  it("spawns godot --headless --path --script and returns captured output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "headless-"));
    try {
      await writeFile(path.join(root, "project.godot"), "");
      const spawn = vi.fn().mockImplementation(() => child(0));
      const runner = new HeadlessRunner({ spawn: spawn as never });
      const result = await runner.run({
        godotPath: "godot",
        projectPath: root,
        source: "extends SceneTree\nfunc _init():\n\tprint(\"hello-headless\")\n\tquit()\n",
      });
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("hello-headless");
      expect(spawn).toHaveBeenCalledWith(
        "godot",
        expect.arrayContaining(["--headless", "--path", root, "--script"]),
        expect.objectContaining({ shell: false, windowsHide: true }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("times out and kills a hung child", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "headless-timeout-"));
    try {
      await writeFile(path.join(root, "project.godot"), "");
      const hung = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn>; pid: number };
      hung.stdout = new EventEmitter();
      hung.stderr = new EventEmitter();
      hung.kill = vi.fn();
      hung.pid = 99;
      const spawn = vi.fn().mockReturnValue(hung);
      const runner = new HeadlessRunner({ spawn: spawn as never });
      await expect(runner.run({
        godotPath: "godot",
        projectPath: root,
        source: "extends SceneTree\nfunc _init():\n\tpass\n",
        timeoutMs: 100,
      })).rejects.toMatchObject({ code: "timeout" });
      expect(hung.kill).toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
