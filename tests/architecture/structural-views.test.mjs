import test from "node:test";
import assert from "node:assert/strict";
import { extractMermaidBlocks } from "../../docs/architecture/render.mjs";
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

const phaseIds = [
  "PHASE-00-RESEARCH",
  "PHASE-00-MASTER",
  "PHASE-01",
  "PHASE-02",
  "PHASE-03",
  "PHASE-04",
  "PHASE-05",
  "PHASE-06",
  "PHASE-07",
  "PHASE-08",
  "FLOW-PH-001",
  "FLOW-PH-002",
  "FLOW-PH-003",
  "FLOW-PH-004",
  "FLOW-PH-005",
  "FLOW-PH-006",
  "FLOW-PH-007",
  "FLOW-PH-008",
  "FLOW-PH-009",
  "FLOW-PH-010",
  "FLOW-PH-011",
  "FLOW-PH-012",
  "FLOW-PH-013",
  "FLOW-PH-014",
  "FLOW-PH-015",
  "FLOW-PH-016",
  "FLOW-PH-017",
  "FLOW-PH-018",
];

const phaseEdges = new Map([
  ["FLOW-PH-001", 'PHASE_00_RESEARCH -->|"adopted research guardrails"| PHASE_01'],
  ["FLOW-PH-002", 'PHASE_00_MASTER -->|"standards + phase plan"| PHASE_01'],
  ["FLOW-PH-003", 'PHASE_01 -->|"JsonRpcClient.call · registerTool · godot_compat.gd"| PHASE_02'],
  ["FLOW-PH-004", 'PHASE_01 -->|"transport · registerTool · errors"| PHASE_03'],
  ["FLOW-PH-005", 'PHASE_02 -->|"TypeParser · IntrospectionService"| PHASE_03'],
  ["FLOW-PH-006", 'PHASE_01 -->|"config · logger · errors"| PHASE_04'],
  ["FLOW-PH-007", 'PHASE_02 -.->|"completed coordination · Q-002 resolved for Phase 4"| PHASE_04'],
  ["FLOW-PH-008", 'PHASE_01 -->|"transport · config · log · errors"| PHASE_05'],
  ["FLOW-PH-009", 'PHASE_02 -->|"execution contract"| PHASE_05'],
  ["FLOW-PH-010", 'PHASE_01 -->|"config · logger · errors"| PHASE_06'],
  ["FLOW-PH-011", 'PHASE_02 -.->|"? unresolved · Q-002"| PHASE_06'],
  ["FLOW-PH-012", 'PHASE_01 -->|"JsonRpcClient.call"| PHASE_07'],
  ["FLOW-PH-013", 'PHASE_02 -->|"execution guard"| PHASE_07'],
  ["FLOW-PH-014", 'PHASE_03 -->|"23 curated tools · shared mutation lane"| PHASE_07'],
  ["FLOW-PH-015", 'PHASE_04 -->|"LSP tools"| PHASE_07'],
  ["FLOW-PH-016", 'PHASE_05 -->|"runtime + debug tools"| PHASE_07'],
  ["FLOW-PH-017", 'PHASE_06 -->|"FsGuard + batch/fs/uid tools"| PHASE_07'],
  ["FLOW-PH-018", 'PHASE_07 -->|"SafetyPolicy · RequestQueue · Cache · Health · AuditLog"| PHASE_08'],
]);

const componentIds = [
  "CMP-MCP-BOOTSTRAP",
  "CMP-REGISTRY",
  "CMP-SCHEMA-CONTRACTS",
  "CMP-TOOL-FAMILIES",
  "CMP-RESOURCE-PROMPT-SURFACES",
  "CMP-SAFETY",
  "CMP-REQUEST-QUEUE",
  "CMP-READ-CACHE",
  "CMP-AUDIT",
  "CMP-HEALTH",
  "CMP-SEMANTIC-SERVICES",
  "CMP-TRANSPORT-ADAPTERS",
  "CMP-WS-SERVER",
  "CMP-COMMAND-ROUTER",
  "CMP-CORE-COMMANDS",
  "CMP-INTROSPECTION-COMMANDS",
  "CMP-EXEC-COMMANDS",
  "CMP-EDIT-COMMANDS",
  "CMP-EDIT-CONTROLLER",
  "CMP-GODOT-COMPAT",
  "CMP-RUNTIME-AUTOLOADS",
  "SYS-EDITOR-APIS",
  "SYS-CLASSDB-DOCS",
  "SYS-UNDO-REDO",
  ...Array.from({ length: 23 }, (_, index) => `FLOW-CMP-${String(index + 1).padStart(3, "0")}`),
];

const componentEdges = new Map([
  ["FLOW-CMP-001", 'CMP_MCP_BOOTSTRAP -->|"register surfaces"| CMP_REGISTRY'],
  ["FLOW-CMP-002", 'CMP_REGISTRY -->|"validate structured I/O"| CMP_SCHEMA_CONTRACTS'],
  ["FLOW-CMP-003", 'CMP_REGISTRY -->|"apply policy gate"| CMP_SAFETY'],
  ["FLOW-CMP-004", 'CMP_SAFETY -->|"serialize mutations"| CMP_REQUEST_QUEUE'],
  ["FLOW-CMP-005", 'CMP_SAFETY -->|"cache read-only calls"| CMP_READ_CACHE'],
  ["FLOW-CMP-006", 'CMP_REGISTRY -->|"record calls"| CMP_AUDIT'],
  ["FLOW-CMP-007", 'CMP_AUDIT -->|"report status"| CMP_HEALTH'],
  ["FLOW-CMP-008", 'CMP_REGISTRY -->|"dispatch tools"| CMP_TOOL_FAMILIES'],
  ["FLOW-CMP-009", 'CMP_REGISTRY -->|"serve resources + prompts"| CMP_RESOURCE_PROMPT_SURFACES'],
  ["FLOW-CMP-010", 'CMP_TOOL_FAMILIES -->|"parse + introspect"| CMP_SEMANTIC_SERVICES'],
  ["FLOW-CMP-011", 'CMP_TOOL_FAMILIES -->|"select execution channel"| CMP_TRANSPORT_ADAPTERS'],
  ["FLOW-CMP-012", 'CMP_TRANSPORT_ADAPTERS -->|"WebSocket + JSON-RPC 2.0"| CMP_WS_SERVER'],
  ["FLOW-CMP-013", 'CMP_WS_SERVER -->|"dispatch command"| CMP_COMMAND_ROUTER'],
  ["FLOW-CMP-014", 'CMP_COMMAND_ROUTER -->|"route core"| CMP_CORE_COMMANDS'],
  ["FLOW-CMP-015", 'CMP_COMMAND_ROUTER -->|"route introspection"| CMP_INTROSPECTION_COMMANDS'],
  ["FLOW-CMP-016", 'CMP_COMMAND_ROUTER -->|"route Tier B execution"| CMP_EXEC_COMMANDS'],
  ["FLOW-CMP-017", 'CMP_COMMAND_ROUTER -->|"route Tier A edits"| CMP_EDIT_COMMANDS'],
  ["FLOW-CMP-018", 'CMP_EDIT_COMMANDS -->|"delegate mutations"| CMP_EDIT_CONTROLLER'],
  ["FLOW-CMP-019", 'CMP_EDIT_CONTROLLER -->|"create + commit actions"| SYS_UNDO_REDO'],
  ["FLOW-CMP-020", 'CMP_INTROSPECTION_COMMANDS -->|"query ClassDB + core.get_version-gated offline docs"| SYS_CLASSDB_DOCS'],
  ["FLOW-CMP-021", 'CMP_COMMAND_ROUTER -->|"isolate version-sensitive calls"| CMP_GODOT_COMPAT'],
  ["FLOW-CMP-022", 'CMP_GODOT_COMPAT -->|"invoke editor services"| SYS_EDITOR_APIS'],
  ["FLOW-CMP-023", 'CMP_TRANSPORT_ADAPTERS -->|"sequenced runtime IPC"| CMP_RUNTIME_AUTOLOADS'],
]);

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
      "query ClassDB + gate offline docs by core.get_version",
      "LSP JSON-RPC over TCP 6005",
      "ProcessRunner sole spawn + exact-child control",
      "attach-only DAP over TCP 6006",
      "authenticated pre-request locked socket or user:// file IPC",
      "spawn godot --headless --script",
      "guarded project-root file and UID access",
      "provider API · protocol unspecified",
    ],
  });

  const channelAnchors = markdown.match(/%% atlas-node: CH-[A-Z0-9-]+/g) ?? [];
  assert.equal(channelAnchors.length, 5, "02-container-channels.md: top-level channel count");
});

test("phase dependency view maps the exact work-order contracts", async () => {
  const markdown = await assertView("03-phase-dependencies.md", {
    ids: phaseIds,
    tokens: [
      ARCHIVE_SHA256,
      "flowchart TB",
      "JsonRpcClient.call",
      "registerTool",
      "godot_compat.gd",
      "TypeParser",
      "IntrospectionService",
      "SafetyPolicy",
      "RequestQueue",
      "Cache",
      "Health",
      "AuditLog",
      "Objective",
      "Consumes",
      "Produces",
      "Isolation stub",
      "Acceptance evidence",
    ],
  });

  const [block] = extractMermaidBlocks(markdown);
  const lines = block.split(/\r?\n/);
  for (const [flowId, edge] of phaseEdges) {
    const anchor = lines.findIndex((line) => line.trim() === `%% atlas-flow: ${flowId}`);
    assert.notEqual(anchor, -1, `03-phase-dependencies.md: ${flowId} anchor`);
    assert.equal(lines[anchor + 1].trim(), edge, `03-phase-dependencies.md: ${flowId} edge`);
  }
});

test("server component view maps the exact grouped code boundaries", async () => {
  const markdown = await assertView("04-server-components.md", {
    ids: componentIds,
    tokens: [
      ARCHIVE_SHA256,
      "flowchart TB",
      "MCP surface",
      "TypeScript server",
      "GDScript editor plugin",
      "Godot editor/runtime + pinned knowledge services",
      "Tier A",
      "Tier B",
      "TypeParser",
      "WebSocket",
      "LSP",
      "DAP",
      "ProcessRunner",
      "runtime IPC",
      "HeadlessRunner",
      "FsGuard",
      "UID/export",
      "optional AssetProvider",
    ],
  });

  const [block] = extractMermaidBlocks(markdown);
  const lines = block.split(/\r?\n/);
  for (const [flowId, edge] of componentEdges) {
    const anchors = lines
      .map((line, index) => line.trim() === `%% atlas-flow: ${flowId}` ? index : -1)
      .filter((index) => index >= 0);
    assert.equal(anchors.length, 1, `04-server-components.md: ${flowId} anchor count`);
    assert.equal(lines[anchors[0] + 1].trim(), edge, `04-server-components.md: ${flowId} edge`);
  }
});

test("system context keeps the engineer and MCP-client role inside the workstation", async () => {
  const markdown = await assertView("01-system-context.md", { ids: contextIds });
  const [block] = extractMermaidBlocks(markdown);
  const localStart = block.indexOf('subgraph LOCAL_WORKSTATION["Local workstation · personal-use scope"]');
  const localEnd = block.indexOf("\n  end", localStart);
  const actorAnchor = block.indexOf("%% atlas-node: ACT-ENGINEER-AI");
  assert.ok(localStart < actorAnchor && actorAnchor < localEnd, "ACT-ENGINEER-AI must be inside local workstation");
});

test("container view includes every cited phase source in its baseline", async () => {
  const markdown = await assertView("02-container-channels.md", { ids: channelIds });
  const sourceBaseline = markdown.slice(
    markdown.indexOf("## Source baseline"),
    markdown.indexOf("## Container and channel view"),
  );
  assert.ok(
    sourceBaseline.includes("phase-02-introspection-and-universal-primitive.md"),
    "02-container-channels.md: Phase 2 source belongs in source baseline",
  );
});

test("shared editor transport has one FLOW-CH-003 edge", async () => {
  const markdown = await assertView("02-container-channels.md", { ids: channelIds });
  const [block] = extractMermaidBlocks(markdown);
  const lines = block.split(/\r?\n/);
  const flowAnchor = lines.findIndex((line) => line.trim() === "%% atlas-flow: FLOW-CH-003");
  assert.notEqual(flowAnchor, -1, "02-container-channels.md: FLOW-CH-003 anchor");
  assert.match(
    lines[flowAnchor + 1].trim(),
    /^CNT_TYPESCRIPT_SERVER -->\|"WebSocket \+ JSON-RPC 2\.0 on localhost:9200"\| CNT_EDITOR_PLUGIN$/,
    "FLOW-CH-003 must map one server-to-plugin transport edge",
  );
});
