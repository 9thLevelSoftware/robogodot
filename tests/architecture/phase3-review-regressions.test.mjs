import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Phase 3 public contract and limitations stay explicit", async () => {
  const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
  for (const phrase of ["31 public tools", "single FIFO mutation lane", "session-scoped", "fail-closed", "TOCTOU", "Phase 6/7"]) assert.match(readme, new RegExp(phrase, "i"));
  assert.match(readme, /get_path.*get_child_count.*is_inside_tree/s);
  assert.match(readme, /1024 UTF-8 bytes/);
  assert.match(readme, /Ctrl-Z/);
});

test("Q-005 is accepted and CI runs Phase 3 live acceptance", async () => {
  const questions = await readFile(new URL("../../docs/architecture/open-questions.md", import.meta.url), "utf8");
  assert.match(questions, /Q-005` — \*\*Resolved/);
  assert.match(questions, /Accepted resolution:.*exact previous state/is);
  const ci = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /npm run test:live\r?\n\s+npm run test:live:phase3/);
});

test("named Godot smokes enforce canonical plugin compilation from a clean fixture", async () => {
  const compat = await readFile(new URL("../../addons/godot_control_mcp/godot_compat.gd", import.meta.url), "utf8");
  assert.match(compat, /var node: Node = stack\.pop_back\(\)/);
  for (const name of ["editor_plugin_missing_token_smoke.gd", "editor_plugin_lifecycle_smoke.gd"]) {
    const smoke = await readFile(new URL(`../godot/${name}`, import.meta.url), "utf8");
    assert.match(smoke, /preload\("res:\/\/addons\/godot_control_mcp\/plugin\.gd"\)/);
  }
  const runner = await readFile(new URL("../godot/run-smoke.mjs", import.meta.url), "utf8");
  const invocations = [...runner.matchAll(/await run\((\[[\s\S]*?)\);/g)];
  assert.equal(invocations.length, 12);
  for (const invocation of invocations) assert.match(invocation[1], /"PASS /);
  assert.match(runner, /await rm\(resolve\(root, "tests\/fixtures\/godot_project\/addons"\)[\s\S]*?await cp\(/);
  assert.match(runner, /forbiddenOutput/);
});
