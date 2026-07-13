import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relativePath) => readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");

const phase5Tools = [
  "godot_run_project", "godot_stop_project", "godot_run_output",
  "godot_runtime_scene_tree", "godot_runtime_get_node", "godot_runtime_input", "godot_runtime_screenshot",
  "godot_debug_launch", "godot_debug_set_breakpoints", "godot_debug_continue", "godot_debug_step", "godot_debug_stack", "godot_debug_inspect",
];

const phase5Contracts = [
  ["godot_run_project", "optional `scene`, optional `arguments`", '`{ sessionId, mode: "normal", pid, bridgeTransport?, startedAt }`', [false, false, false, true]],
  ["godot_stop_project", "`sessionId`", "`{ sessionId, alreadyStopped, graceful, forced, exit? }`; `exit` has `code`, `signal`, `at`, optional `error`", [false, true, true, true]],
  ["godot_run_output", "`sessionId`; `since` safe integer ≥0, default 0; `limit` 1–500, default 100", "`{ sessionId, running, exit?, records, next, lost, truncated }`; each record has `cursor`, `stream` (`stdout` or `stderr`), `at`, `text`, `truncated`", [true, false, false, true]],
  ["godot_runtime_scene_tree", "`sessionId`; `maxDepth` 1–32, default 8", "`{ sessionId, nodes, truncated: { nodes, depth } }`; each node has `path`, `name`, `type`, `depth`", [true, false, true, true]],
  ["godot_runtime_get_node", "`sessionId`, node `path`, up to 64 allowlisted `properties`", "`{ sessionId, path, type, properties, omittedProperties }`", [true, false, true, true]],
  ["godot_runtime_input", "`sessionId` and exactly one `action`, `key`, or `mouse_button` form; `holdMs` 0–2000", "`{ sessionId, accepted: true }`", [false, false, false, true]],
  ["godot_runtime_screenshot", "`sessionId`; optional contained leaf `.png` name", '`{ sessionId, path, absolutePath, width, height, bytes, sha256, format: "png" }`', [false, false, false, true]],
  ["godot_debug_launch", "optional `scene`, optional `arguments`; `timeoutMs` 100–60000, default 15000", '`{ sessionId, mode: "debug", state: "debug_ready", pid, bridgeTransport?, startedAt }`', [false, false, false, true]],
  ["godot_debug_set_breakpoints", "`sessionId`, one contained project-relative `.gd` `path`, up to 500 unique positive `lines`", "`{ sessionId, path, breakpoints }` with the adapter's bounded replaced results", [false, false, true, true]],
  ["godot_debug_continue", "`sessionId`, stopped `thread` reference", "`{ sessionId, resumed: true }`", [false, false, false, true]],
  ["godot_debug_step", "`sessionId`, stopped `thread`, `kind` `over` or `into`", "`{ sessionId, kind, resumed: true }`", [false, false, false, true]],
  ["godot_debug_stack", "`sessionId`; optional stopped `thread`; `startFrame` safe integer ≥0", "`{ sessionId, stoppedGeneration, threads, frames, totalFrames?, truncated }` with bounded references", [true, false, false, true]],
  ["godot_debug_inspect", "`sessionId`, stopped `frame`; optional `variables`; `start` safe integer ≥0", "Scope page: `{ sessionId, stoppedGeneration, scopes, truncated }`. Variable page: `{ sessionId, stoppedGeneration, variables, next?, truncated }`.", [true, false, false, true]],
];

function parsePhase5ContractRows(readme) {
  const section = readme.split("| Tool | Exact inputs | Normalized success output | MCP annotations")[1]?.split("\n\n")[0] ?? "";
  return section.split(/\r?\n/).filter(line => /^\| `godot_/.test(line)).map(line => {
    const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
    const annotations = [...cells[3].matchAll(/`(true|false)`/g)].map(match => match[1] === "true");
    return [cells[0].replaceAll("`", ""), cells[1], cells[2], annotations];
  });
}

test("Phase 5 runbook documents the exact 13-tool contract and exact 51-tool inventory", async () => {
  const [readme, runtimeTools, debugTools, serverTest] = await Promise.all([
    read("README.md"), read("server/src/tools/runtime.ts"), read("server/src/tools/debug.ts"), read("server/tests/server.test.ts"),
  ]);
  assert.match(readme, /Phase 5/);
  assert.match(readme, /exactly 51 public tools/i);
  for (const name of phase5Tools) {
    assert.match(readme, new RegExp(`\\b${name}\\b`), `README tool: ${name}`);
    assert.match(`${runtimeTools}\n${debugTools}`, new RegExp(`name: "${name}"`), `registered tool: ${name}`);
  }
  const registered = [...serverTest.matchAll(/"(godot_[a-z0-9_]+)"/g)].map((match) => match[1]);
  const inventory = readme.match(/<!-- exact-51-tool-inventory -->([^]*?)<!-- \/exact-51-tool-inventory -->/)?.[1] ?? "";
  const documented = [...inventory.matchAll(/`(godot_[a-z0-9_]+)`/g)].map((match) => match[1]);
  assert.equal(new Set(documented).size, 51);
  assert.deepEqual(documented, registered.slice(0, 51));

  assert.deepEqual(parsePhase5ContractRows(readme), phase5Contracts, "all 13 rows must bind exact tool, inputs, output, and four annotations");
  assert.match(readme, /32 arguments[^\n]*1,024 UTF-8 bytes[^\n]*8,192 total UTF-8 bytes/i);
  assert.match(readme, /readOnlyHint[^\n]*destructiveHint[^\n]*idempotentHint[^\n]*openWorldHint/i);
  assert.match(readme, /structuredContent[^\n]*omitted[^\n]*error/i);
  assert.doesNotMatch(debugTools, /z\.looseObject/);
  for (const schema of ["launchOutput", "breakpointsOutput", "continueOutput", "stepOutput", "stackOutput", "inspectOutput"]) assert.match(debugTools, new RegExp(`const ${schema} = z\\.object\\(`));
});

test("Phase 5 runbook states runtime, bridge, DAP, failure, cleanup, and live verification boundaries", async () => {
  const readme = await read("README.md");
  for (const pattern of [
    /ProcessRunner[^\n]*sole[^\n]*process owner/i,
    /plugin[^\n]*resolve[^\n]*user:\/\//i,
    /pre-request[^\n]*handshake[^\n]*lock/i,
    /hello_ready/,
    /never[^\n]*(replay|replayed)[^\n]*transport/i,
    /attach-only/i,
    /no[^\n]*evaluate/i,
    /stoppedGeneration[^\n]*invalidat/i,
    /exact child/i,
    /bridge[^\n]*before[^\n]*process/i,
    /dummy renderer/i,
    /GODOT_DAP_PORT[^\n]*6006/,
    /GODOT_PATH[^\n]*Godot_v4\.6\.2-stable_mono_win64_console\.exe/,
    /GODOT_PROJECT_PATH[^\n]*tests[\\/]fixtures[\\/]godot_project/i,
    /npm run test:live:phase5/,
    /node tests\/godot\/run-smoke\.mjs/,
    /\.NET SDK 8\.0\.28[^\n]*non-fatal/i,
    /Xvfb :99/,
    /hosted Linux execution remains CI evidence/i,
    /Phase 6[^\n]*future/i,
    /Phase 7[^\n]*future/i,
    /Phase 8[^\n]*future/i,
  ]) assert.match(readme, pattern);
});

test("Phase 5 decisions and architecture reflect only implemented evidence", async () => {
  const [questions, channels, phases, components, sequence, lifecycles, traceability] = await Promise.all([
    read("docs/architecture/open-questions.md"), read("docs/architecture/02-container-channels.md"),
    read("docs/architecture/03-phase-dependencies.md"), read("docs/architecture/04-server-components.md"),
    read("docs/architecture/06-runtime-debug-sequence.md"), read("docs/architecture/08-connection-lifecycles.md"),
    read("docs/architecture/traceability.md"),
  ]);
  for (const id of ["Q-010", "Q-011", "Q-012"]) {
    const row = questions.split(/\r?\n/).find((line) => line.startsWith(`| \`${id}\``)) ?? "";
    assert.match(row, /Resolved|Accepted/i, id);
    assert.doesNotMatch(row, /Proposal \(not source truth\)/i, id);
  }
  assert.match(questions, /Q-010[^\n]*ProcessRunner[^\n]*(sole|alone)[^\n]*(spawn|owner)/i);
  assert.match(questions, /Q-011[^\n]*Godot[^\n]*canonical[^\n]*user:\/\//i);
  assert.match(questions, /Q-012[^\n]*authenticated[^\n]*pre-request[^\n]*(lock|locked)[^\n]*never[^\n]*replay/i);
  assert.match(channels, /CH-RUNTIME-DEBUG[^\n]*Implemented/i);
  assert.match(phases, /PHASE-05[^\n]*implemented/i);
  assert.match(components, /Runtime[^\n]*debug[^\n]*Implemented/i);
  assert.match(sequence, /implemented/i);
  assert.match(sequence, /ProcessRunner/);
  assert.match(sequence, /attach-only/i);
  assert.match(lifecycles, /Phase 5[^\n]*implemented/i);
  assert.match(lifecycles, /attach-only/i);
  assert.match(lifecycles, /stoppedGeneration/);
  assert.match(traceability, /Q-010[^\n]*(Resolved|Accepted)/i);
  assert.match(traceability, /Q-011[^\n]*(Resolved|Accepted)/i);
  assert.match(traceability, /Q-012[^\n]*(Resolved|Accepted)/i);
});

test("CI keeps the cross-platform matrix and runs every live suite fail-closed", async () => {
  const ci = await read(".github/workflows/ci.yml");
  assert.match(ci, /os: \[ubuntu-latest, windows-latest\]/);
  for (const command of ["npm run test:live", "npm run test:live:phase3", "npm run test:live:phase4", "npm run test:live:phase5"]) {
    const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.equal((ci.match(new RegExp(`run: ${escaped}(?:\\r?\\n|$)`, "g")) ?? []).length, 1, `${command} must own one fail-closed step`);
  }
  for (const existing of ["Architecture", "Server tests", "Typecheck and build", "Offline documentation integrity", "Plugin smoke"]) assert.match(ci, new RegExp(`name: ${existing}`));
  assert.match(ci, /Xvfb :99/); assert.match(ci, /DISPLAY=:99/);
});

test("runtime bridge parity uses advertised UTF-8 byte limits and peer readiness proof", async () => {
  const [scene, input, screenshot, bridge, client, trace, sequence, renderedSequence] = await Promise.all([
    read("addons/godot_control_mcp/runtime/scene_bridge.gd"), read("addons/godot_control_mcp/runtime/input_bridge.gd"),
    read("addons/godot_control_mcp/runtime/screenshot_bridge.gd"), read("addons/godot_control_mcp/runtime/runtime_bridge.gd"),
    read("server/src/runtime/bridge-client.ts"), read("docs/architecture/traceability.md"), read("docs/architecture/06-runtime-debug-sequence.md"), read("docs/architecture/rendered/06-runtime-debug-sequence.svg"),
  ]);
  for (const source of [scene, input, screenshot]) assert.match(source, /to_utf8_buffer\(\)\.size\(\) > 256/);
  assert.match(bridge, /hello_ready/); assert.match(bridge, /robogodot-ready-v1/);
  assert.match(client, /hello_ready/); assert.match(client, /robogodot-ready-v1/);
  for (const source of [trace, sequence]) {
    assert.match(source, /user:\/\/\.mcp\/<sessionId>\/req-<id>\.json/);
    assert.match(source, /user:\/\/\.mcp\/<sessionId>\/resp-<id>\.json/);
  }
  assert.doesNotMatch(`${trace}\n${sequence}`, /user:\/\/\.mcp\/resp-<id>\.json/);
  const visibleSvgText = renderedSequence.replace(/<[^>]+>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  assert.match(visibleSvgText, /user:\/\/\.mcp\/<sessionId>\/req-<id>\.json/, "rendered visible text must preserve the exact request path without abbreviation or hyphenation");
  assert.match(visibleSvgText, /user:\/\/\.mcp\/<sessionId>\/resp-<id>\.json/, "rendered visible text must preserve the exact response path without hyphenation");
  assert.match(trace, /req-<id>\.json/); assert.doesNotMatch(trace, /host path and socket fallback unresolved/i);
});
