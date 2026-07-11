import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("CaptureLogger bounds output from one UTF-8 encoding", async () => {
  const source = await readFile(new URL("../../addons/godot_control_mcp/commands/exec.gd", import.meta.url), "utf8");
  const method = source.match(/\r?\n\tfunc _append_bounded\(text: String\) -> String:\r?\n([\s\S]*?)(?=\r?\n\tfunc )/)?.[1];
  assert.ok(method, "CaptureLogger._append_bounded must exist");
  assert.match(method, /text\.to_utf8_buffer\(\)/, "encode the input once before applying its byte cap");
  assert.doesNotMatch(method, /for\s+character\s+in\s+text/, "do not encode and append one character at a time");
});

test("missing-token smoke does not disable the plugin needed by the lifecycle smoke", async () => {
  const source = await readFile(new URL("../godot/editor_plugin_missing_token_smoke.gd", import.meta.url), "utf8");
  assert.doesNotMatch(source, /EditorInterface\.set_plugin_enabled\(plugin_path, false\)/);
});
