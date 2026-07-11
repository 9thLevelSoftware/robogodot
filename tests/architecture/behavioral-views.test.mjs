import test from "node:test";
import assert from "node:assert/strict";
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
