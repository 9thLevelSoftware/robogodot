import test from "node:test";
import assert from "node:assert/strict";
import { assertView } from "./assertions.mjs";

const ARCHIVE_SHA256 = "0B78D0AC0B0676AEFD31A394ADBB95980B6AC2A6273246840325633CB1F96229";

const contextIds = [
  "ACT-ENGINEER-AI",
  "SYS-GODOT-CONTROL-MCP",
  "SYS-GODOT-EDITOR-PROJECT",
  "SYS-RUNNING-GAME",
  "SYS-PROJECT-FILES",
  "SYS-ASSET-PROVIDER",
  "FLOW-CTX-001",
  "FLOW-CTX-002",
  "FLOW-CTX-003",
  "FLOW-CTX-004",
  "FLOW-CTX-005",
  "FLOW-CTX-006",
];

const channelIds = [
  "CNT-MCP-CLIENT",
  "CNT-TYPESCRIPT-SERVER",
  "CH-EDITOR-MUTATION",
  "CH-INTROSPECTION",
  "CH-CODE-INTELLIGENCE",
  "CH-RUNTIME-DEBUG",
  "CH-HEADLESS-BATCH-FS",
  "CNT-EDITOR-PLUGIN",
  "SYS-CLASSDB-DOCS",
  "CNT-GODOT-LSP",
  "CNT-GODOT-DAP",
  "CNT-RUNNING-GAME",
  "CNT-RUNTIME-AUTOLOADS",
  "CNT-HEADLESS-GODOT",
  "CNT-PROJECT-STORAGE",
  "CNT-ASSET-PROVIDER",
  "FLOW-CH-001",
  "FLOW-CH-002",
  "FLOW-CH-003",
  "FLOW-CH-004",
  "FLOW-CH-005",
  "FLOW-CH-006",
  "FLOW-CH-007",
  "FLOW-CH-008",
  "FLOW-CH-009",
  "FLOW-CH-010",
  "FLOW-CH-011",
  "FLOW-CH-012",
];

test("system context has the complete accessible local-control model", async () => {
  await assertView("01-system-context.md", {
    ids: contextIds,
    tokens: [
      ARCHIVE_SHA256,
      "flowchart LR",
      "Local workstation · personal-use scope",
      "External optional service",
      "uses tools, resources, and prompts via MCP",
      "controls and observes local Godot work",
      "edits scenes and resources through editor APIs",
      "launches and observes the running game",
      "reads and writes guarded project files",
      "optionally requests generated assets",
      "TypeScript server is the control plane",
      "Godot is the authoritative executor",
      "Provider transport details are not specified",
    ],
  });
});

test("container view has exactly the five source-defined channels", async () => {
  const markdown = await assertView("02-container-channels.md", {
    ids: channelIds,
    tokens: [
      ARCHIVE_SHA256,
      "flowchart LR",
      "Editor mutation",
      "Introspection / API knowledge",
      "Code intelligence",
      "Runtime / debug",
      "Headless / batch + filesystem",
      "MCP over stdio",
      "route editor mutation",
      "WebSocket + JSON-RPC 2.0 on localhost:9200",
      "route live introspection",
      "query ClassDB and integrated documentation",
      "LSP JSON-RPC over TCP 6005",
      "spawn and control the game process",
      "DAP over TCP 6006",
      "correlated user:// file IPC",
      "spawn godot --headless --script",
      "guarded project-root file and UID access",
      "provider API · protocol unspecified",
    ],
  });

  const channelAnchors = markdown.match(/%% atlas-node: CH-[A-Z0-9-]+/g) ?? [];
  assert.equal(channelAnchors.length, 5, "02-container-channels.md: top-level channel count");
});
