import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/architecture");

const expected = [
  "Q-001", "Q-002", "Q-003", "Q-004",
  "Q-005", "Q-006", "Q-007", "Q-008",
  "Q-009", "Q-010", "Q-011", "Q-012",
  "Q-013", "Q-014", "Q-015", "Q-016",
];

test("records the ordered open-question inventory and required columns", async () => {
  const markdown = await readFile(path.join(ROOT, "open-questions.md"), "utf8");
  assert.deepEqual([...markdown.matchAll(/^\| `(Q-[0-9]{3})`/gm)].map((match) => match[1]), expected);
  assert.match(
    markdown,
    /\| ID \| Decision needed \| Conflicting evidence \| Implementation impact \| Recommended resolution \| Owning phase \|/,
  );
  assert.match(markdown, /Q-003[^\n]+Resolved \/ superseded by \[ADR 0001\]/);
  assert.match(markdown, /TypeScript client owns one JSON-RPC `core\.ping` heartbeat/);
  assert.match(markdown, /1 second through a 60-second cap/);
});
