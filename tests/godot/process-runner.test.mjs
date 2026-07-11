import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runBounded } from "./process-runner.mjs";

function child(pid) {
  const value = new EventEmitter();
  value.pid = pid;
  value.kill = () => value.emit("exit", null);
  return value;
}

test("Windows timeout preserves the original error when taskkill errors", async () => {
  const calls = [];
  const godot = child(42);
  const spawnImpl = (command, args) => {
    calls.push([command, args]);
    if (command !== "taskkill") return godot;
    const killer = child(43);
    queueMicrotask(() => killer.emit("error", new Error("taskkill unavailable")));
    return killer;
  };
  await assert.rejects(runBounded("godot", ["--headless"], { platform: "win32", spawnImpl, timeoutMs: 1, cleanupTimeoutMs: 10 }), /Godot timed out after 1 ms/);
  assert.deepEqual(calls[1], ["taskkill", ["/PID", "42", "/T", "/F"]]);
});

test("Windows timeout bounds a hung taskkill cleanup", async () => {
  const started = Date.now();
  const spawnImpl = (command) => command === "taskkill" ? child(44) : child(42);
  await assert.rejects(runBounded("godot", [], { platform: "win32", spawnImpl, timeoutMs: 1, cleanupTimeoutMs: 10 }), /Godot timed out/);
  assert.ok(Date.now() - started < 250);
});

test("child exit during cleanup cannot replace the original timeout", async () => {
  const godot = child(42);
  const spawnImpl = (command) => {
    if (command !== "taskkill") return godot;
    const killer = child(44);
    queueMicrotask(() => {
      godot.emit("exit", 1);
      killer.emit("exit", 0);
    });
    return killer;
  };
  await assert.rejects(runBounded("godot", ["parity.gd"], { platform: "win32", spawnImpl, timeoutMs: 1 }), /Godot timed out.*parity\.gd/);
});

test("Unix timeout kills only the detached child process group", async () => {
  const kills = [];
  await assert.rejects(runBounded("godot", [], { platform: "linux", spawnImpl: () => child(77), killImpl: (...args) => kills.push(args), timeoutMs: 1 }), /Godot timed out/);
  assert.deepEqual(kills, [[-77, "SIGKILL"]]);
});
