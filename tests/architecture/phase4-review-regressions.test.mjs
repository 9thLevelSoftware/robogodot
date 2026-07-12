import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relativePath) => readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");

const toolNames = [
  "godot_lsp_diagnostics",
  "godot_lsp_completion",
  "godot_lsp_hover",
  "godot_lsp_signature_help",
  "godot_lsp_document_symbols",
  "godot_lsp_workspace_symbols",
  "godot_lsp_native_symbol",
];

test("Phase 4 runbook documents the exact public surface and operating contract", async () => {
  const [readme, tools] = await Promise.all([read("README.md"), read("server/src/tools/lsp.ts")]);
  for (const name of toolNames) assert.match(readme, new RegExp(`\\b${name}\\b`));
  for (const name of toolNames) assert.match(tools, new RegExp(`name: "${name}"`));
  assert.match(tools, /position = z\.object\(\{ line:[^]*character:[^]*\}\)\.strict\(\)/);
  assert.match(tools, /context: z\.object\(\{ triggerKind:[^]*min\(1\)\.max\(3\)[^]*triggerCharacter:[^]*optional\(\)[^]*\}\)\.strict\(\)\.optional\(\)/);
  assert.match(tools, /truncation: snapshot\.truncation[^]*diagnostics: false[^]*relatedInformation: false[^]*malformed: false/);
  assert.match(tools, /flags = \{ signatures: false, parameters: false, malformed: false, strings: false \}/);

  const requiredContractTokens = [
    "line", "character", "start", "end", "triggerKind", "triggerCharacter",
    "message", "severity", "code", "source", "tags", "relatedInformation", "location",
    "detail", "kind", "documentation", "insertText", "sortText", "filterText", "textEdit", "newText",
    "contents", "activeSignature", "activeParameter", "parameters", "selectionRange", "children",
    "signatures", "strings", "positions", "malformed", "feature_disabled", "not_connected", "godot_error",
  ];
  for (const token of requiredContractTokens) assert.match(readme, new RegExp(`\\b${token}\\b`), `README contract token: ${token}`);
  const row = (name) => readme.split(/\r?\n/).filter((line) => line.startsWith(`| \`${name}\``)).at(-1) ?? "";
  const perTool = {
    godot_lsp_diagnostics: ["uri", "waitMs", "message", "range", "relatedInformation", "diagnostics", "tags", "strings", "positions", "malformed"],
    godot_lsp_completion: ["uri", "position", "limit", "context", "triggerKind", "triggerCharacter", "label", "textEdit", "newText", "truncated"],
    godot_lsp_hover: ["uri", "position", "found: false", "found: true", "contents", "range", "truncated"],
    godot_lsp_signature_help: ["uri", "position", "activeSignature", "activeParameter", "parameters", "signatures", "strings", "malformed"],
    godot_lsp_document_symbols: ["uri", "name", "selectionRange", "location", "children", "truncated"],
    godot_lsp_workspace_symbols: ["query", "limit", "symbols", "not_connected", "feature_disabled", "godot_error"],
    godot_lsp_native_symbol: ["nativeClass", "member", "found: false", "found: true", "symbol", "truncated", "godot_error"],
  };
  for (const [name, tokens] of Object.entries(perTool)) {
    for (const token of tokens) assert.ok(row(name).includes(token), `${name} contract token: ${token}`);
  }
  assert.match(readme, /GODOT_LSP_PORT[^\n]*6005/);
  assert.match(readme, /GODOT_MCP_LSP_AUTO_START[^\n]*false/i);
  assert.match(readme, /godot --editor --headless --lsp-port 6005 --path <project>/);
  assert.match(readme, /zero-based[^\n]*UTF-16/i);
  assert.match(readme, /Godot 4\.6[^\n]*workspace\/symbol[^\n]*feature_disabled/i);
  assert.match(readme, /readOnlyHint[^\n]*true/);
  assert.match(readme, /shutdown[^\n]*owned-child-only/i);
  assert.match(readme, /not_connected/);
  assert.match(readme, /diagnostics[^\n]*timeout/i);
});

test("Phase 4 dependency is resolved without deciding Phase 6", async () => {
  const [phases, openQuestions, traceability] = await Promise.all([
    read("docs/architecture/03-phase-dependencies.md"),
    read("docs/architecture/open-questions.md"),
    read("docs/architecture/traceability.md"),
  ]);
  assert.match(phases, /PHASE_01 -->\|"config · logger · errors"\| PHASE_04/);
  assert.match(phases, /Phase 2[^\n]*(coordination|regression)/i);
  assert.doesNotMatch(phases, /PHASE_02 -\.->\|"\? unresolved · Q-002"\| PHASE_04/);
  assert.match(phases, /PHASE_02 -\.->\|"\? unresolved · Q-002"\| PHASE_06/);
  assert.match(openQuestions, /Q-002[^]*Phase 4[^]*Resolved/i);
  assert.match(openQuestions, /Phase 6[^]*(unresolved|open)/i);
  assert.match(traceability, /FLOW-PH-007[^\n]*(Resolved|coordination)/i);
});

test("Phase 4 atlas identifies implemented LSP boundaries", async () => {
  const [components, lifecycle, channels] = await Promise.all([
    read("docs/architecture/04-server-components.md"),
    read("docs/architecture/08-connection-lifecycles.md"),
    read("docs/architecture/02-container-channels.md"),
  ]);
  assert.match(components, /Code intelligence[^\n]*Implemented/i);
  assert.match(components, /LSP[^\n]*attach[^\n]*owned/i);
  assert.match(lifecycle, /Phase 4[^\n]*implemented/i);
  assert.match(lifecycle, /owned-child-only/i);
  assert.match(channels, /CH-CODE-INTELLIGENCE[^\n]*Implemented/i);
});
