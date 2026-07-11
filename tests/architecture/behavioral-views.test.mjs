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
