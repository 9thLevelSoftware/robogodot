import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractMermaidBlocks } from "../../docs/architecture/render.mjs";
import { assertView } from "./assertions.mjs";

const mutationParticipants = [
  "CNT-MCP-CLIENT",
  "CMP-REGISTRY",
  "CMP-SCHEMA-CONTRACTS",
  "CMP-SEMANTIC-SERVICES",
  "CMP-SAFETY",
  "CMP-REQUEST-QUEUE",
  "CMP-WS-CLIENT",
  "CMP-COMMAND-ROUTER",
  "CMP-EDIT-CONTROLLER",
  "SYS-UNDO-REDO",
  "CMP-READ-CACHE",
  "CMP-AUDIT",
];

const mutationMessages = new Map([
  ["FLOW-MUT-001", "MCP_CLIENT->>REGISTRY: MCP call enters registry"],
  ["FLOW-MUT-002", "REGISTRY->>SCHEMAS: Zod schema validation"],
  ["FLOW-MUT-003", "SCHEMAS->>SEMANTICS: path/property/type validation through semantic services"],
  ["FLOW-MUT-004", "SEMANTICS->>SAFETY: safety mode and annotation evaluation"],
  ["FLOW-MUT-005", "SEMANTICS-->>MCP_CLIENT: invalid_args"],
  ["FLOW-MUT-006", "SAFETY-->>MCP_CLIENT: blocked_by_policy"],
  ["FLOW-MUT-007", "SAFETY->>AUDIT: [INFERRED] blocked outcome reaches audit (Q-007)"],
  ["FLOW-MUT-008", "SAFETY->>QUEUE: enqueue one FIFO mutation"],
  ["FLOW-MUT-009", "QUEUE->>WS_CLIENT: correlated JSON-RPC call"],
  ["FLOW-MUT-010", "WS_CLIENT->>ROUTER: route edit command"],
  ["FLOW-MUT-011", "ROUTER->>EDIT: create one undo action"],
  ["FLOW-MUT-012", "EDIT->>UNDO_REDO: register do/undo operations"],
  ["FLOW-MUT-013", "EDIT->>UNDO_REDO: commit action"],
  ["FLOW-MUT-014", "WS_CLIENT-->>QUEUE: result returns through transport"],
  ["FLOW-MUT-015", "QUEUE->>CACHE: invalidate affected cache tags"],
  ["FLOW-MUT-016", "REGISTRY->>AUDIT: append redacted audit outcome"],
  ["FLOW-MUT-017", "REGISTRY-->>MCP_CLIENT: return structuredContent"],
  ["FLOW-MUT-018", "EDIT->>EDIT: [ACCEPTED] reject unless prior setting presence/value restores exactly (Q-005)"],
]);

const mutationIds = [...mutationParticipants, ...mutationMessages.keys()];

const runtimeParticipants = [
  "CNT-MCP-CLIENT",
  "CMP-RUNTIME-TOOLS",
  "CMP-PROCESS-RUNNER",
  "CNT-RUNNING-GAME",
  "CMP-DAP-CLIENT",
  "CNT-GODOT-DAP",
  "CMP-RUNTIME-DRIVER",
  "CMP-RUNTIME-AUTOLOADS",
  "CNT-RUNTIME-IPC-FILES",
  "CMP-AUDIT",
];

const runtimeMessages = new Map([
  ["FLOW-RUN-001", "MCP_CLIENT->>RUNTIME_TOOLS: godot_run_project"],
  ["FLOW-RUN-002", "PROCESS_RUNNER->>RUNNING_GAME: spawn godot --path <project> [scene]"],
  ["FLOW-RUN-003", "RUNNING_GAME-->>PROCESS_RUNNER: stream stdout/stderr into ring buffer"],
  ["FLOW-RUN-004", "MCP_CLIENT->>RUNTIME_TOOLS: incremental output using since/next"],
  ["FLOW-RUN-005", "RUNTIME_TOOLS->>DAP_CLIENT: initialize DAP"],
  ["FLOW-RUN-006", "DAP_CLIENT->>GODOT_DAP: [UNRESOLVED] launch or attach ownership (Q-010)"],
  ["FLOW-RUN-007", "RUNTIME_TOOLS->>RUNTIME_DRIVER: inject/use bridge autoloads through Phase 2 execution"],
  ["FLOW-RUN-008", "MCP_CLIENT->>RUNTIME_TOOLS: runtime inspect/input/screenshot request"],
  ["FLOW-RUN-009", "RUNTIME_TOOLS->>RUNTIME_DRIVER: allocate monotonic request ID"],
  ["FLOW-RUN-010", "RUNTIME_DRIVER->>IPC_FILES: write user://.mcp/req.json"],
  ["FLOW-RUN-011", "AUTOLOADS->>IPC_FILES: autoload polls and reads request"],
  ["FLOW-RUN-012", "AUTOLOADS->>RUNNING_GAME: execute requested operation"],
  ["FLOW-RUN-013", "AUTOLOADS->>IPC_FILES: write user://.mcp/resp-<id>.json"],
  ["FLOW-RUN-014", "RUNTIME_DRIVER->>IPC_FILES: server reads and deletes response"],
  ["FLOW-RUN-015", "RUNTIME_TOOLS-->>MCP_CLIENT: return structured result"],
  ["FLOW-RUN-016", "RUNTIME_TOOLS-->>MCP_CLIENT: timeout alternative with game-not-running hint"],
  ["FLOW-RUN-017", "RUNTIME_TOOLS-->>MCP_CLIENT: screenshot alternative returns path, dimensions, and PNG"],
  ["FLOW-RUN-018", "RUNTIME_TOOLS->>PROCESS_RUNNER: graceful stop, then force if required"],
  ["FLOW-RUN-019", "RUNTIME_TOOLS->>RUNTIME_TOOLS: remove IPC files, end DAP, clean orphan PID"],
  ["FLOW-RUN-020", "RUNTIME_TOOLS->>AUDIT: audit outcome"],
]);

const runtimeIds = [...runtimeParticipants, ...runtimeMessages.keys()];

const policyNodes = [
  "CNT-MCP-CLIENT",
  "CMP-REGISTRY",
  "CMP-MODE-GATE",
  "CMP-PATH-GUARD",
  "CMP-EXEC-GUARD",
  "CMP-REQUEST-CLASSIFIER",
  "CMP-READ-CACHE",
  "CMP-REQUEST-QUEUE",
  "CMP-HANDLER",
  "CMP-CACHE-INVALIDATOR",
  "CMP-AUDIT",
  "SYS-STRUCTURED-RESULT",
  "SYS-STRUCTURED-ERROR",
];

const policyEdges = new Map([
  ["FLOW-POL-001", 'MCP_CLIENT -->|"tool call"| REGISTRY'],
  ["FLOW-POL-002", 'REGISTRY -->|"annotations and mode"| MODE_GATE'],
  ["FLOW-POL-003", 'MODE_GATE -->|"allowed"| PATH_GUARD'],
  ["FLOW-POL-004", 'PATH_GUARD -->|"path safe"| EXEC_GUARD'],
  ["FLOW-POL-005", 'MODE_GATE -.->|"«inferred» blocked_by_policy (Q-007)"| AUDIT'],
  ["FLOW-POL-006", 'PATH_GUARD -.->|"«inferred» blocked path (Q-007)"| AUDIT'],
  ["FLOW-POL-007", 'EXEC_GUARD -.->|"«inferred» blocked execution (Q-006, Q-007)"| AUDIT'],
  ["FLOW-POL-008", 'AUDIT -->|"rejected outcome"| STRUCTURED_ERROR'],
  ["FLOW-POL-009", 'EXEC_GUARD -->|"safe request"| REQUEST_CLASSIFIER'],
  ["FLOW-POL-010", 'REQUEST_CLASSIFIER -->|"read-only"| READ_CACHE'],
  ["FLOW-POL-011", 'READ_CACHE -->|"cache hit"| AUDIT'],
  ["FLOW-POL-012", 'READ_CACHE -->|"cache miss"| HANDLER'],
  ["FLOW-POL-013", 'REQUEST_CLASSIFIER -->|"mutation"| REQUEST_QUEUE'],
  ["FLOW-POL-014", 'REQUEST_QUEUE -->|"FIFO dispatch"| HANDLER'],
  ["FLOW-POL-015", 'HANDLER -->|"mutation success"| CACHE_INVALIDATOR'],
  ["FLOW-POL-016", 'CACHE_INVALIDATOR -->|"affected tags invalidated"| AUDIT'],
  ["FLOW-POL-017", 'HANDLER -->|"read success"| AUDIT'],
  ["FLOW-POL-018", 'HANDLER -->|"stable mapped failure"| AUDIT'],
  ["FLOW-POL-019", 'AUDIT -->|"successful outcome"| STRUCTURED_RESULT'],
  ["FLOW-POL-020", 'STRUCTURED_RESULT -->|"structuredContent"| MCP_CLIENT'],
]);

const policyIds = [...policyNodes, ...policyEdges.keys()];

const lifecycleViews = [
  {
    heading: "## Editor WebSocket transport lifecycle",
    states: [
      "STATE-WS-DISCONNECTED",
      "STATE-WS-CONNECTING",
      "STATE-WS-CONNECTED",
      "STATE-WS-RECONNECTING",
    ],
    transitions: new Map([
      ["FLOW-WS-001", "[*] --> WS_DISCONNECTED"],
      ["FLOW-WS-002", "WS_DISCONNECTED --> WS_CONNECTING : start"],
      ["FLOW-WS-003", "WS_CONNECTING --> WS_CONNECTED : socket open"],
      ["FLOW-WS-004", "WS_CONNECTING --> WS_RECONNECTING : connection failure"],
      ["FLOW-WS-005", "WS_CONNECTED --> WS_RECONNECTING : close or missed heartbeat (Q-003)"],
      ["FLOW-WS-006", "WS_RECONNECTING --> WS_CONNECTING : backoff elapsed"],
    ]),
    evidence: "Explicit",
    phase: "Phase 1",
  },
  {
    heading: "## Godot LSP document lifecycle",
    states: [
      "STATE-LSP-DISCONNECTED",
      "STATE-LSP-TCP-CONNECTED",
      "STATE-LSP-INITIALIZING",
      "STATE-LSP-READY",
      "STATE-LSP-DOCUMENT-SYNCED",
      "STATE-LSP-RECONNECTING",
      "STATE-LSP-SHUTTING-DOWN",
      "STATE-LSP-EXITED",
    ],
    transitions: new Map([
      ["FLOW-LSP-001", "[*] --> LSP_DISCONNECTED : [INFERRED] initial disconnected state"],
      ["FLOW-LSP-002", "LSP_DISCONNECTED --> LSP_TCP_CONNECTED : [INFERRED] TCP connect"],
      ["FLOW-LSP-003", "LSP_TCP_CONNECTED --> LSP_INITIALIZING : [INFERRED] initialize"],
      ["FLOW-LSP-004", "LSP_INITIALIZING --> LSP_READY : [INFERRED] initialized"],
      ["FLOW-LSP-005", "LSP_READY --> LSP_DOCUMENT_SYNCED : [INFERRED] didOpen"],
      ["FLOW-LSP-006", "LSP_DOCUMENT_SYNCED --> LSP_DOCUMENT_SYNCED : [INFERRED] didChange"],
      ["FLOW-LSP-007", "LSP_READY --> LSP_RECONNECTING : [INFERRED] connection drop"],
      ["FLOW-LSP-008", "LSP_DOCUMENT_SYNCED --> LSP_RECONNECTING : [INFERRED] connection drop"],
      ["FLOW-LSP-009", "LSP_RECONNECTING --> LSP_TCP_CONNECTED : [INFERRED] reconnect"],
      ["FLOW-LSP-010", "LSP_READY --> LSP_SHUTTING_DOWN : [INFERRED] shutdown"],
      ["FLOW-LSP-011", "LSP_SHUTTING_DOWN --> LSP_EXITED : [INFERRED] exit"],
    ]),
    evidence: "Inferred",
    phase: "Phase 4",
  },
  {
    heading: "## Managed game process lifecycle",
    states: [
      "STATE-PROC-STOPPED",
      "STATE-PROC-STARTING",
      "STATE-PROC-RUNNING",
      "STATE-PROC-STOPPING",
      "STATE-PROC-EXITED",
      "STATE-PROC-CRASHED",
      "STATE-PROC-FORCE-STOPPING",
    ],
    transitions: new Map([
      ["FLOW-PROC-001", "[*] --> PROC_STOPPED : [INFERRED] initial stopped state"],
      ["FLOW-PROC-002", "PROC_STOPPED --> PROC_STARTING : [INFERRED] run"],
      ["FLOW-PROC-003", "PROC_STARTING --> PROC_RUNNING : [INFERRED] process started"],
      ["FLOW-PROC-004", "PROC_STARTING --> PROC_CRASHED : [INFERRED] launch failure"],
      ["FLOW-PROC-005", "PROC_RUNNING --> PROC_STOPPING : [INFERRED] graceful stop"],
      ["FLOW-PROC-006", "PROC_STOPPING --> PROC_STOPPED : [INFERRED] clean exit"],
      ["FLOW-PROC-007", "PROC_STOPPING --> PROC_FORCE_STOPPING : [INFERRED] timeout"],
      ["FLOW-PROC-008", "PROC_FORCE_STOPPING --> PROC_STOPPED : [INFERRED] killed and cleaned"],
      ["FLOW-PROC-009", "PROC_RUNNING --> PROC_EXITED : [INFERRED] process exit"],
      ["FLOW-PROC-010", "PROC_RUNNING --> PROC_CRASHED : [INFERRED] abnormal exit"],
    ]),
    evidence: "Inferred",
    phase: "Phase 5",
  },
  {
    heading: "## Godot DAP session lifecycle",
    states: [
      "STATE-DAP-DISCONNECTED",
      "STATE-DAP-INITIALIZED",
      "STATE-DAP-LAUNCHED-ATTACHED",
      "STATE-DAP-RUNNING",
      "STATE-DAP-PAUSED",
      "STATE-DAP-TERMINATED",
    ],
    transitions: new Map([
      ["FLOW-DAP-001", "[*] --> DAP_DISCONNECTED : [INFERRED] initial disconnected state"],
      ["FLOW-DAP-002", "DAP_DISCONNECTED --> DAP_INITIALIZED : [INFERRED] initialize"],
      ["FLOW-DAP-003", "DAP_INITIALIZED --> DAP_LAUNCHED_ATTACHED : [INFERRED] launch or attach (Q-010)"],
      ["FLOW-DAP-004", "DAP_LAUNCHED_ATTACHED --> DAP_RUNNING : [INFERRED] continue"],
      ["FLOW-DAP-005", "DAP_RUNNING --> DAP_PAUSED : [INFERRED] breakpoint or pause"],
      ["FLOW-DAP-006", "DAP_PAUSED --> DAP_RUNNING : [INFERRED] continue"],
      ["FLOW-DAP-007", "DAP_PAUSED --> DAP_PAUSED : [INFERRED] step"],
      ["FLOW-DAP-008", "DAP_RUNNING --> DAP_TERMINATED : [INFERRED] terminate"],
      ["FLOW-DAP-009", "DAP_PAUSED --> DAP_TERMINATED : [INFERRED] terminate"],
    ]),
    evidence: "Inferred",
    phase: "Phase 5",
  },
];

const lifecycleIds = lifecycleViews.flatMap(({ states, transitions }) => [...states, ...transitions.keys()]);

function sectionBetween(markdown, startHeading, endHeading) {
  const start = markdown.indexOf(startHeading);
  const end = markdown.indexOf(endHeading, start + startHeading.length);
  assert.notEqual(start, -1, `${startHeading} exists`);
  assert.notEqual(end, -1, `${endHeading} exists after ${startHeading}`);
  return markdown.slice(start, end);
}

function tableRows(section, idPattern) {
  return section
    .split(/\r?\n/)
    .filter((line) => idPattern.test(line));
}

test("curated editor mutation sequence preserves the normative order and failure ownership", async () => {
  const markdown = await assertView("05-editor-mutation-sequence.md", {
    ids: mutationIds,
    tokens: [
      "sequenceDiagram",
      "invalid_args",
      "blocked_by_policy",
      "not_connected",
      "timeout",
      "godot_error",
      "cache invalidation",
      "structuredContent",
      "[INFERRED]",
      "Q-007",
      "[ACCEPTED]",
      "Q-005",
    ],
  });

  const [block] = extractMermaidBlocks(markdown);
  const lines = block.split(/\r?\n/);
  const participantAnchors = lines
    .map((line) => line.trim().match(/^%% atlas-node: (.+)$/)?.[1])
    .filter(Boolean);
  assert.deepEqual(participantAnchors, mutationParticipants, "participant declaration order");

  const flowAnchors = lines
    .map((line) => line.trim().match(/^%% atlas-flow: (FLOW-MUT-\d{3})$/)?.[1])
    .filter(Boolean);
  assert.deepEqual(flowAnchors, [...mutationMessages.keys()], "mutation flow order");

  for (const [flowId, message] of mutationMessages) {
    const anchor = lines.findIndex((line) => line.trim() === `%% atlas-flow: ${flowId}`);
    assert.notEqual(anchor, -1, `${flowId} anchor`);
    assert.equal(lines[anchor + 1].trim(), message, `${flowId} message`);
  }
});

test("curated mutation view has exhaustive adjacent participant and relationship outlines", async () => {
  const markdown = await assertView("05-editor-mutation-sequence.md", { ids: mutationIds });
  const diagramEnd = markdown.indexOf("```", markdown.indexOf("```mermaid") + 3);
  const participantHeading = markdown.indexOf("## Participant outline");
  const relationshipHeading = markdown.indexOf("## Relationship outline");
  assert.ok(diagramEnd < participantHeading, "participant outline follows the diagram");
  assert.ok(participantHeading < relationshipHeading, "relationship outline follows participants");

  const participantSection = sectionBetween(markdown, "## Participant outline", "## Relationship outline");
  assert.ok(
    participantSection.includes("| Participant | Responsibility | Phase owner | Protocol / boundary |"),
    "participant outline columns",
  );
  const participantRows = tableRows(participantSection, /^\| `(?:CNT|CMP|SYS)-[A-Z0-9-]+` \|/);
  assert.deepEqual(
    participantRows.map((row) => row.match(/^\| `([^`]+)` \|/)[1]),
    mutationParticipants,
    "participant outline inventory",
  );
  for (const row of participantRows) {
    assert.equal(row.split("|").length, 6, `participant outline column count: ${row}`);
    assert.match(row, /\| (?:Phase|Phases|Consumer integration)/, `participant phase owner: ${row}`);
  }

  const relationshipSection = sectionBetween(markdown, "## Relationship outline", "## Failure ownership and consequences");
  assert.ok(
    relationshipSection.includes(
      "| Flow | From → To | Message / outcome | Evidence | Phase / protocol | Source / trace |",
    ),
    "relationship outline columns",
  );
  const relationshipRows = tableRows(relationshipSection, /^\| `FLOW-MUT-\d{3}` \|/);
  assert.deepEqual(
    relationshipRows.map((row) => row.match(/^\| `([^`]+)` \|/)[1]),
    [...mutationMessages.keys()],
    "relationship outline inventory",
  );

  for (const [index, row] of relationshipRows.entries()) {
    const flowId = `FLOW-MUT-${String(index + 1).padStart(3, "0")}`;
    const expectedEvidence = flowId === "FLOW-MUT-007"
      ? "Inferred"
      : flowId === "FLOW-MUT-018" ? "Accepted" : "Explicit";
    assert.equal(row.split("|").length, 8, `relationship outline column count: ${flowId}`);
    assert.equal(row.split("|")[4].trim(), expectedEvidence, `${flowId} evidence`);
    assert.match(row.split("|")[5], /Phases? .+\/.+/, `${flowId} phase and protocol detail`);
    assert.ok(
      row.includes("[trace](traceability.md#architecture-atlas-traceability)"),
      `${flowId} trace link`,
    );
  }

  assert.ok(markdown.includes("[Traceability index](traceability.md#architecture-atlas-traceability)"));
  assert.ok(markdown.includes("[Open-question register](open-questions.md#architecture-open-questions)"));
  assert.ok(relationshipRows[6].includes("[Q-007](open-questions.md#architecture-open-questions)"));
  assert.ok(relationshipRows[17].includes("[Q-005](open-questions.md#architecture-open-questions)"));
});

test("stale or ambiguous NodePath failures belong to the routed Godot error branch", async () => {
  const markdown = await assertView("05-editor-mutation-sequence.md", { ids: mutationIds });
  const [block] = extractMermaidBlocks(markdown);
  assert.ok(block.includes("else Invalid property/type arguments"));
  assert.ok(block.includes("alt godot_error — stale/ambiguous NodePath or command failure"));
  assert.ok(block.includes("stale/ambiguous NodePath returns the current tree"));

  const invalidArgsRow = markdown.split(/\r?\n/).find((line) => line.startsWith("| `invalid_args` |"));
  assert.ok(invalidArgsRow, "invalid_args ownership row");
  assert.doesNotMatch(invalidArgsRow, /stale|NodePath|\bpath\b/i);

  const relationshipSection = sectionBetween(markdown, "## Relationship outline", "## Failure ownership and consequences");
  const flow005 = relationshipSection.split(/\r?\n/).find((line) => line.startsWith("| `FLOW-MUT-005` |"));
  const flow014 = relationshipSection.split(/\r?\n/).find((line) => line.startsWith("| `FLOW-MUT-014` |"));
  assert.doesNotMatch(flow005, /stale|NodePath|\bpath\b/i);
  assert.match(flow014, /godot_error.*stale\/ambiguous NodePath/i);

  const traceability = await readFile(new URL("../../docs/architecture/traceability.md", import.meta.url), "utf8");
  const trace005 = traceability.split(/\r?\n/).find((line) => line.startsWith("| `FLOW-MUT-005` |"));
  const trace014 = traceability.split(/\r?\n/).find((line) => line.startsWith("| `FLOW-MUT-014` |"));
  assert.doesNotMatch(trace005, /stale|NodePath|\bpath\b/i);
  assert.match(trace014, /godot_error.*stale\/ambiguous NodePath/i);
});

test("runtime debug sequence preserves the exact setup, interaction, and shutdown contract", async () => {
  const markdown = await assertView("06-runtime-debug-sequence.md", {
    ids: runtimeIds,
    tokens: [
      "sequenceDiagram",
      "SETUP",
      "INTERACTION",
      "SHUTDOWN",
      "since",
      "next",
      "req.json",
      "resp-<id>.json",
      "PNG",
      "[UNRESOLVED]",
      "Q-010",
      "Q-011",
      "Q-012",
      "game-not-running",
      "degrade to process + bridge",
    ],
  });

  const [block] = extractMermaidBlocks(markdown);
  const lines = block.split(/\r?\n/);
  const participantAnchors = lines
    .map((line) => line.trim().match(/^%% atlas-node: (.+)$/)?.[1])
    .filter(Boolean);
  assert.deepEqual(participantAnchors, runtimeParticipants, "participant declaration order");

  const flowAnchors = lines
    .map((line) => line.trim().match(/^%% atlas-flow: (FLOW-RUN-\d{3})$/)?.[1])
    .filter(Boolean);
  assert.deepEqual(flowAnchors, [...runtimeMessages.keys()], "runtime flow order");

  for (const [flowId, message] of runtimeMessages) {
    const anchor = lines.findIndex((line) => line.trim() === `%% atlas-flow: ${flowId}`);
    assert.notEqual(anchor, -1, `${flowId} anchor`);
    assert.equal(lines[anchor + 1].trim(), message, `${flowId} message`);
  }

  const responseAlternative = lines.findIndex(
    (line) => line.trim() === "alt Response file appears before the per-request timeout",
  );
  const flow014 = lines.findIndex((line) => line.trim() === "%% atlas-flow: FLOW-RUN-014");
  const flow015 = lines.findIndex((line) => line.trim() === "%% atlas-flow: FLOW-RUN-015");
  const timeoutAlternative = lines.findIndex((line) => line.trim() === "else Response deadline expires");
  const flow016 = lines.findIndex((line) => line.trim() === "%% atlas-flow: FLOW-RUN-016");
  assert.ok(
    responseAlternative >= 0
      && responseAlternative < flow014
      && flow014 < flow015
      && flow015 < timeoutAlternative
      && timeoutAlternative < flow016,
    "response read/delete belongs only to the success branch while preserving flow order",
  );

  const setup = block.indexOf("SETUP");
  const interaction = block.indexOf("INTERACTION");
  const shutdown = block.indexOf("SHUTDOWN");
  assert.ok(setup < interaction && interaction < shutdown, "phase bands stay visually ordered");
});

test("runtime screenshot result requires a successful IPC response", async () => {
  const markdown = await assertView("06-runtime-debug-sequence.md", { ids: runtimeIds });
  const [block] = extractMermaidBlocks(markdown);
  const lines = block.split(/\r?\n/);
  const successResult = lines.findIndex((line) => line.trim() === "%% atlas-flow: FLOW-RUN-015");
  const timeoutAlternative = lines.findIndex((line) => line.trim() === "else Response deadline expires");
  const timeoutResult = lines.findIndex((line) => line.trim() === "%% atlas-flow: FLOW-RUN-016");
  const responseEnd = lines.findIndex((line, index) => index > timeoutResult && line.trim() === "end");
  const screenshotGuard = lines.findIndex(
    (line) => line.trim() === "opt Successful IPC response and requested operation is a screenshot",
  );
  const screenshotResult = lines.findIndex((line) => line.trim() === "%% atlas-flow: FLOW-RUN-017");

  assert.notEqual(screenshotGuard, -1, "screenshot opt explicitly requires a successful IPC response");
  assert.ok(
    successResult < timeoutAlternative
      && timeoutAlternative < timeoutResult
      && timeoutResult < responseEnd
      && responseEnd < screenshotGuard
      && screenshotGuard < screenshotResult,
    "success-conditioned screenshot result follows the closed response alternative in normative flow order",
  );
  assert.doesNotMatch(
    lines.slice(timeoutAlternative, responseEnd + 1).join("\n"),
    /FLOW-RUN-017/,
    "timeout branch cannot return a screenshot result",
  );
});

test("runtime debug view has exhaustive adjacent participant and relationship outlines", async () => {
  const markdown = await assertView("06-runtime-debug-sequence.md", { ids: runtimeIds });
  const diagramEnd = markdown.indexOf("```", markdown.indexOf("```mermaid") + 3);
  const participantHeading = markdown.indexOf("## Participant outline");
  const relationshipHeading = markdown.indexOf("## Relationship outline");
  assert.ok(diagramEnd < participantHeading, "participant outline follows the diagram");
  assert.ok(participantHeading < relationshipHeading, "relationship outline follows participants");

  const participantSection = sectionBetween(markdown, "## Participant outline", "## Relationship outline");
  assert.ok(
    participantSection.includes("| Participant | Responsibility | Phase owner | Protocol / boundary |"),
    "participant outline columns",
  );
  const participantRows = tableRows(participantSection, /^\| `(?:CNT|CMP)-[A-Z0-9-]+` \|/);
  assert.deepEqual(
    participantRows.map((row) => row.match(/^\| `([^`]+)` \|/)[1]),
    runtimeParticipants,
    "participant outline inventory",
  );
  for (const row of participantRows) {
    assert.equal(row.split("|").length, 6, `participant outline column count: ${row}`);
    assert.match(row, /\| (?:Phase|Consumer integration)/, `participant phase owner: ${row}`);
  }

  const relationshipSection = sectionBetween(markdown, "## Relationship outline", "## Failure and degradation ownership");
  assert.ok(
    relationshipSection.includes(
      "| Flow | From → To | Message / outcome | Evidence | Phase / protocol | Source / trace |",
    ),
    "relationship outline columns",
  );
  const relationshipRows = tableRows(relationshipSection, /^\| `FLOW-RUN-\d{3}` \|/);
  assert.deepEqual(
    relationshipRows.map((row) => row.match(/^\| `([^`]+)` \|/)[1]),
    [...runtimeMessages.keys()],
    "relationship outline inventory",
  );

  for (const [index, row] of relationshipRows.entries()) {
    const flowId = `FLOW-RUN-${String(index + 1).padStart(3, "0")}`;
    assert.equal(row.split("|").length, 8, `relationship outline column count: ${flowId}`);
    assert.equal(row.split("|")[4].trim(), flowId === "FLOW-RUN-006" ? "Unresolved" : "Explicit", `${flowId} evidence`);
    assert.match(row.split("|")[5], /Phase 5 \/.+/, `${flowId} phase and protocol detail`);
    assert.ok(
      row.includes("[trace](traceability.md#architecture-atlas-traceability)"),
      `${flowId} trace link`,
    );
  }

  assert.ok(markdown.includes("[Traceability index](traceability.md#architecture-atlas-traceability)"));
  assert.ok(markdown.includes("[Open-question register](open-questions.md#architecture-open-questions)"));
  assert.ok(relationshipRows[5].includes("[Q-010](open-questions.md#architecture-open-questions)"));
  assert.ok(relationshipRows[9].includes("[Q-011](open-questions.md#architecture-open-questions)"));
  assert.ok(relationshipRows[9].includes("[Q-012](open-questions.md#architecture-open-questions)"));
});

test("centralized policy pipeline preserves the exact guarded read, mutation, and outcome flow", async () => {
  const markdown = await assertView("07-policy-pipeline.md", {
    ids: policyIds,
    tokens: [
      "flowchart TD",
      "full",
      "read_only",
      "confirm_destructive",
      "blocked_by_policy",
      "{code, message, hint}",
      "FIFO",
      "TTL",
      "tags",
      "fairness",
      "backpressure",
      "watchdog",
      "Q-006",
      "Q-007",
      "Q-008",
      "Q-009",
      "structuredContent",
    ],
  });

  const [block] = extractMermaidBlocks(markdown);
  const lines = block.split(/\r?\n/);
  assert.equal(lines[0].trim(), "flowchart TD", "policy pipeline direction");

  const nodeAnchors = lines
    .map((line) => line.trim().match(/^%% atlas-node: (.+)$/)?.[1])
    .filter(Boolean);
  assert.deepEqual(nodeAnchors, policyNodes, "policy node declaration order");

  const flowAnchors = lines
    .map((line) => line.trim().match(/^%% atlas-flow: (FLOW-POL-\d{3})$/)?.[1])
    .filter(Boolean);
  assert.deepEqual(flowAnchors, [...policyEdges.keys()], "policy flow order");

  for (const [flowId, edge] of policyEdges) {
    const anchor = lines.findIndex((line) => line.trim() === `%% atlas-flow: ${flowId}`);
    assert.notEqual(anchor, -1, `${flowId} anchor`);
    assert.equal(lines[anchor + 1].trim(), edge, `${flowId} edge`);
  }

  for (const flowId of ["FLOW-POL-005", "FLOW-POL-006", "FLOW-POL-007"]) {
    assert.match(policyEdges.get(flowId), /-\.->/, `${flowId} is visibly inferred without color`);
    assert.match(policyEdges.get(flowId), /«inferred»/, `${flowId} uses flowchart evidence notation`);
  }
  assert.equal(
    [...policyEdges.values()].filter((edge) => edge.startsWith("STRUCTURED_ERROR ")).length,
    0,
    "structured error visually terminates rejected outcomes",
  );
});

test("policy view has exhaustive adjacent node and relationship outlines plus trace rows", async () => {
  const markdown = await assertView("07-policy-pipeline.md", { ids: policyIds });
  const diagramEnd = markdown.indexOf("```", markdown.indexOf("```mermaid") + 3);
  const nodeHeading = markdown.indexOf("## Node outline");
  const relationshipHeading = markdown.indexOf("## Relationship outline");
  assert.ok(diagramEnd < nodeHeading, "node outline follows the diagram");
  assert.ok(nodeHeading < relationshipHeading, "relationship outline follows nodes");

  const nodeSection = sectionBetween(markdown, "## Node outline", "## Relationship outline");
  assert.ok(
    nodeSection.includes(
      "| Node | Responsibility | Evidence | Phase owner | Protocol / boundary | Source / trace / open questions |",
    ),
    "node outline columns",
  );
  const nodeRows = tableRows(nodeSection, /^\| `(?:CNT|CMP|SYS)-[A-Z0-9-]+` \|/);
  assert.deepEqual(
    nodeRows.map((row) => row.match(/^\| `([^`]+)` \|/)[1]),
    policyNodes,
    "node outline inventory",
  );
  for (const row of nodeRows) {
    const cells = row.split("|");
    assert.equal(cells.length, 8, `node outline column count: ${row}`);
    assert.equal(cells[3].trim(), "Explicit", `node evidence: ${row}`);
    assert.match(cells[4], /(?:Phase|Consumer integration)/, `node phase owner: ${row}`);
    assert.ok(cells[5].trim(), `node protocol or boundary: ${row}`);
    assert.ok(row.includes("[trace](traceability.md#architecture-atlas-traceability)"), `node trace link: ${row}`);
  }

  const relationshipSection = sectionBetween(
    markdown,
    "## Relationship outline",
    "## Policy, concurrency, and consistency risks",
  );
  assert.ok(
    relationshipSection.includes(
      "| Flow | From → To | Message / outcome | Evidence | Phase / protocol | Source / trace |",
    ),
    "relationship outline columns",
  );
  const relationshipRows = tableRows(relationshipSection, /^\| `FLOW-POL-\d{3}` \|/);
  assert.deepEqual(
    relationshipRows.map((row) => row.match(/^\| `([^`]+)` \|/)[1]),
    [...policyEdges.keys()],
    "relationship outline inventory",
  );
  for (const [index, row] of relationshipRows.entries()) {
    const flowId = `FLOW-POL-${String(index + 1).padStart(3, "0")}`;
    const expectedEvidence = index >= 4 && index <= 6 ? "Inferred" : "Explicit";
    const cells = row.split("|");
    assert.equal(cells.length, 8, `relationship outline column count: ${flowId}`);
    assert.equal(cells[4].trim(), expectedEvidence, `${flowId} evidence`);
    assert.match(cells[5], /Phases? .+\/.+/, `${flowId} phase and protocol detail`);
    assert.ok(row.includes("[trace](traceability.md#architecture-atlas-traceability)"), `${flowId} trace link`);
  }

  assert.ok(markdown.includes("[Traceability index](traceability.md#architecture-atlas-traceability)"));
  assert.ok(markdown.includes("[Open-question register](open-questions.md#architecture-open-questions)"));
  for (const question of ["Q-006", "Q-007", "Q-008", "Q-009"]) {
    assert.ok(
      markdown.includes(`[${question}](open-questions.md#architecture-open-questions)`),
      `${question} direct link`,
    );
  }

  const traceability = await readFile(new URL("../../docs/architecture/traceability.md", import.meta.url), "utf8");
  for (const nodeId of policyNodes) {
    const row = traceability.split(/\r?\n/).find((line) => line.startsWith(`| \`${nodeId}\` |`));
    assert.ok(row, `${nodeId} trace row`);
    assert.ok(row.includes("`07-policy-pipeline.md`"), `${nodeId} includes policy view`);
  }
  const traceRows = traceability
    .split(/\r?\n/)
    .filter((line) => /^\| `FLOW-POL-\d{3}` \|/.test(line));
  assert.deepEqual(
    traceRows.map((row) => row.match(/^\| `([^`]+)` \|/)[1]),
    [...policyEdges.keys()],
    "policy flow trace inventory",
  );
  for (const [index, row] of traceRows.entries()) {
    assert.ok(row.includes("`07-policy-pipeline.md`"), `FLOW-POL trace view: ${row}`);
    assert.match(row, index >= 4 && index <= 6 ? /\| Inferred · `Q-00[67]`/ : /\| Explicit/, `trace evidence: ${row}`);
  }
});

test("policy risks keep queue, consistency, and unresolved guard limits explicit", async () => {
  const markdown = await assertView("07-policy-pipeline.md", { ids: policyIds });
  assert.match(markdown, /queue is not a rollback transaction/i);
  assert.match(markdown, /concurrent reads may observe in-progress mutation state/i);
  assert.match(markdown, /Q-006.+headless GDScript/is);
  assert.match(markdown, /Q-008.+in-progress mutation/is);
  assert.match(markdown, /Q-009.+export output paths/is);
});

test("transport and runtime lifecycles preserve the exact four state machines", async () => {
  const markdown = await assertView("08-connection-lifecycles.md", {
    blockCount: 4,
    ids: lifecycleIds,
    tokens: [
      "stateDiagram-v2",
      "exponential backoff",
      "didOpen",
      "didChange",
      "graceful stop",
      "force",
      "breakpoint or pause",
      "[INFERRED]",
      "Q-003",
      "Q-010",
      "Source status",
      "Operational invariant",
    ],
  });

  const blocks = extractMermaidBlocks(markdown);
  assert.equal(blocks.length, lifecycleViews.length, "one block per named lifecycle export");

  for (const [index, view] of lifecycleViews.entries()) {
    const lines = blocks[index].split(/\r?\n/);
    assert.equal(lines[0].trim(), "stateDiagram-v2", `${view.heading}: diagram type`);
    const stateAnchors = lines
      .map((line) => line.trim().match(/^%% atlas-node: (STATE-[A-Z0-9-]+)$/)?.[1])
      .filter(Boolean);
    assert.deepEqual(stateAnchors, view.states, `${view.heading}: state declaration order`);
    const flowAnchors = lines
      .map((line) => line.trim().match(/^%% atlas-flow: (FLOW-[A-Z]+-\d{3})$/)?.[1])
      .filter(Boolean);
    assert.deepEqual(flowAnchors, [...view.transitions.keys()], `${view.heading}: transition order`);

    for (const [flowId, transition] of view.transitions) {
      const anchor = lines.findIndex((line) => line.trim() === `%% atlas-flow: ${flowId}`);
      assert.notEqual(anchor, -1, `${flowId} anchor`);
      assert.equal(lines[anchor + 1].trim(), transition, `${flowId} transition`);
      assert.match(transition, /-->/, `${flowId}: normal state arrow`);
      assert.doesNotMatch(transition, /-\.->|==>/, `${flowId}: evidence is not encoded by arrow style`);
      if (view.evidence === "Inferred") assert.match(transition, /: \[INFERRED\]/, `${flowId}: inferred label`);
    }
  }

  assert.match(lifecycleViews[0].transitions.get("FLOW-WS-005"), /missed heartbeat \(Q-003\)/);
});

test("lifecycle view has exhaustive adjacent state and transition outlines plus trace rows", async () => {
  const markdown = await assertView("08-connection-lifecycles.md", { blockCount: 4, ids: lifecycleIds });

  for (const [index, view] of lifecycleViews.entries()) {
    const start = markdown.indexOf(view.heading);
    const nextHeading = lifecycleViews[index + 1]?.heading;
    const end = nextHeading ? markdown.indexOf(nextHeading, start + view.heading.length) : markdown.length;
    assert.notEqual(start, -1, `${view.heading}: heading`);
    assert.ok(end > start, `${view.heading}: bounded section`);
    const section = markdown.slice(start, end);
    const diagramEnd = section.indexOf("```", section.indexOf("```mermaid") + 3);
    const sourceStatus = section.indexOf("**Source status.**");
    const invariant = section.indexOf("**Operational invariant.**");
    const stateHeading = section.indexOf("### State outline");
    const transitionHeading = section.indexOf("### Transition outline");
    assert.ok(diagramEnd < sourceStatus, `${view.heading}: source status follows diagram`);
    assert.ok(sourceStatus < invariant, `${view.heading}: source status precedes invariant`);
    assert.ok(invariant < stateHeading, `${view.heading}: invariant precedes state outline`);
    assert.ok(stateHeading < transitionHeading, `${view.heading}: state outline precedes transition outline`);

    const stateSection = section.slice(stateHeading, transitionHeading);
    assert.ok(
      stateSection.includes(
        "| State | Meaning | Evidence | Phase owner | Protocol / boundary | Source / trace / open questions |",
      ),
      `${view.heading}: state outline columns`,
    );
    const stateRows = tableRows(stateSection, /^\| `STATE-[A-Z0-9-]+` \|/);
    assert.deepEqual(
      stateRows.map((row) => row.match(/^\| `([^`]+)` \|/)[1]),
      view.states,
      `${view.heading}: state outline inventory`,
    );
    for (const row of stateRows) {
      const cells = row.split("|");
      assert.equal(cells.length, 8, `state outline column count: ${row}`);
      assert.equal(cells[3].trim(), view.evidence, `state evidence: ${row}`);
      assert.equal(cells[4].trim(), view.phase, `state phase owner: ${row}`);
      assert.ok(cells[5].trim(), `state protocol or boundary: ${row}`);
      assert.ok(row.includes("[trace](traceability.md#architecture-atlas-traceability)"), `state trace link: ${row}`);
    }

    const transitionSection = section.slice(transitionHeading);
    assert.ok(
      transitionSection.includes(
        "| Flow | From → To | Trigger / outcome | Evidence | Phase owner | Protocol / boundary | Source / trace / open questions |",
      ),
      `${view.heading}: transition outline columns`,
    );
    const transitionRows = tableRows(transitionSection, /^\| `FLOW-[A-Z]+-\d{3}` \|/);
    assert.deepEqual(
      transitionRows.map((row) => row.match(/^\| `([^`]+)` \|/)[1]),
      [...view.transitions.keys()],
      `${view.heading}: transition outline inventory`,
    );
    for (const row of transitionRows) {
      const cells = row.split("|");
      assert.equal(cells.length, 9, `transition outline column count: ${row}`);
      assert.equal(cells[4].trim(), view.evidence, `transition evidence: ${row}`);
      assert.equal(cells[5].trim(), view.phase, `transition phase owner: ${row}`);
      assert.ok(cells[6].trim(), `transition protocol or boundary: ${row}`);
      assert.ok(row.includes("[trace](traceability.md#architecture-atlas-traceability)"), `transition trace link: ${row}`);
    }
  }

  assert.ok(markdown.includes("[Q-003](open-questions.md#architecture-open-questions)"), "Q-003 direct link");
  assert.ok(markdown.includes("[Q-010](open-questions.md#architecture-open-questions)"), "Q-010 direct link");

  const traceability = await readFile(new URL("../../docs/architecture/traceability.md", import.meta.url), "utf8");
  const traceRows = traceability.split(/\r?\n/);
  for (const view of lifecycleViews) {
    for (const id of [...view.states, ...view.transitions.keys()]) {
      const row = traceRows.find((line) => line.startsWith(`| \`${id}\` |`));
      assert.ok(row, `${id}: trace row`);
      assert.ok(row.includes("`08-connection-lifecycles.md`"), `${id}: lifecycle view trace`);
      assert.equal(row.split("|")[4].trim(), view.evidence, `${id}: trace evidence`);
    }
  }
  const heartbeatTrace = traceRows.find((line) => line.startsWith("| `FLOW-WS-005` |"));
  assert.match(heartbeatTrace, /resolved `Q-003`; ADR 0001/, "heartbeat transition traces the accepted transport decision");
});
