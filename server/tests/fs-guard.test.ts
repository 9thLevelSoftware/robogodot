import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FsGuard } from "../src/fs/guard.js";
import { GodotMcpError } from "../src/errors.js";

describe("FsGuard", () => {
  it("resolves res:// paths inside the project and rejects traversal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fs-guard-"));
    try {
      await writeFile(path.join(root, "project.godot"), "");
      await mkdir(path.join(root, "scripts"));
      await writeFile(path.join(root, "scripts", "a.gd"), "extends Node\n");
      const guard = await FsGuard.create(root);
      const resolved = await guard.resolveExistingProjectFile("res://scripts/a.gd");
      expect(resolved.res).toBe("res://scripts/a.gd");
      await expect(guard.resolveProjectPath("res://../outside.txt")).rejects.toMatchObject({ code: "invalid_args" });
      await expect(guard.resolveProjectPath("res://scripts/../../secret")).rejects.toMatchObject({ code: "invalid_args" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows export paths under configured export roots only", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fs-export-proj-"));
    const exportRoot = await mkdtemp(path.join(tmpdir(), "fs-export-out-"));
    try {
      await writeFile(path.join(root, "project.godot"), "");
      const guard = await FsGuard.create(root, [exportRoot]);
      const inside = await guard.resolveExportPath(path.join(exportRoot, "game.exe"));
      expect(inside.abs.endsWith("game.exe")).toBe(true);
      const outside = path.join(tmpdir(), `fs-export-denied-${Date.now()}`, "nope.exe");
      await expect(guard.resolveExportPath(outside)).rejects.toBeInstanceOf(GodotMcpError);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(exportRoot, { recursive: true, force: true });
    }
  });
});
