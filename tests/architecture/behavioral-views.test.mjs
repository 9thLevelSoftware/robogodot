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
  ["FLOW-MUT-018", "EDIT->>EDIT: [UNRESOLVED] destructive project-setting exception (Q-005)"],
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
      "[UNRESOLVED]",
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
      : flowId === "FLOW-MUT-018" ? "Unresolved" : "Explicit";
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
