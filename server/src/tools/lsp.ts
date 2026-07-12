import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GodotMcpError } from "../errors.js";
import type { DiagnosticSnapshot } from "../lsp/diagnostics.js";
import type { LspCapability } from "../lsp/protocol.js";
import type { LspPosition, SyncedDocument } from "../lsp/documents.js";
import { registerTool } from "../registry.js";

export interface LspToolClient {
  diagnostics: { sequence: number; waitFor(uri: string, generation: number, afterSequence: number, waitMs: number): Promise<DiagnosticSnapshot> };
  sync(uri: string): Promise<SyncedDocument>;
  assertPosition(document: SyncedDocument, position: LspPosition): void;
  supports(capability: LspCapability): boolean;
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
}

const LSP_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const EXCLUSION = " Godot LSP support is partial; this tool does not expose rename, formatting, or code actions.";
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const boundedString = (max = 1024) => z.string().refine((value) => Buffer.byteLength(value, "utf8") <= max, `Must be at most ${max} UTF-8 bytes.`);
const uri = boundedString();
const position = z.object({ line: z.number().int().min(0).max(1_000_000), character: z.number().int().min(0).max(1_000_000) }).strict();
const limit = z.number().int().min(1).max(500).default(500);
const anyOutput = z.object({}).catchall(z.unknown());
const text = (value: string, max = 8192): string => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= max) return value;
  let end = max; while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
};
const documentation = (value: unknown): string | undefined => {
  if (typeof value === "string") return text(value);
  if (record(value) && typeof value.value === "string") return text(value.value);
  if (Array.isArray(value)) return text(value.flatMap((item) => typeof item === "string" ? [item] : record(item) && typeof item.value === "string" ? [item.value] : []).join("\n"));
};
const remotePosition = (value: unknown): LspPosition | undefined => record(value)
  && Number.isInteger(value.line) && (value.line as number) >= 0 && (value.line as number) <= 1_000_000
  && Number.isInteger(value.character) && (value.character as number) >= 0 && (value.character as number) <= 1_000_000
  ? { line: value.line as number, character: value.character as number } : undefined;
const range = (value: unknown): unknown => {
  if (!record(value)) return undefined; const start = remotePosition(value.start); const end = remotePosition(value.end);
  return start && end ? { start, end } : undefined;
};

function requireCapability(client: LspToolClient, capability: LspCapability): void {
  if (!client.supports(capability)) throw new GodotMcpError("feature_disabled", `The connected Godot language server does not advertise ${capability}.`, capability === "workspaceSymbols" ? "Godot 4.6 does not register workspace/symbol; use document symbols for a specific res:// script." : "Use a Godot version that advertises this LSP capability.");
}
async function positioned(client: LspToolClient, input: { uri: string; position: LspPosition }, capability: LspCapability, method: string, extra: Record<string, unknown> = {}) {
  const document = await client.sync(input.uri); client.assertPosition(document, input.position); requireCapability(client, capability);
  return client.request<unknown>(method, { textDocument: { uri: document.fileUri }, position: input.position, ...extra });
}
function completionItem(value: unknown): Record<string, unknown> | undefined {
  if (!record(value) || typeof value.label !== "string") return;
  const out: Record<string, unknown> = { label: text(value.label, 1024) };
  for (const key of ["detail", "insertText", "sortText", "filterText"] as const) { const field = value[key]; if (typeof field === "string") out[key] = text(field, 1024); }
  if (Number.isInteger(value.kind)) out.kind = value.kind;
  const docs = documentation(value.documentation); if (docs !== undefined) out.documentation = docs;
  if (record(value.textEdit) && typeof value.textEdit.newText === "string") out.textEdit = { range: range(value.textEdit.range), newText: text(value.textEdit.newText, 1024) };
  return out;
}
function normalizeSymbols(values: unknown, limitCount = 1000): { symbols: Record<string, unknown>[]; truncated: boolean } {
  let count = 0, truncated = false;
  const visit = (value: unknown, depth: number): Record<string, unknown> | undefined => {
    if (!record(value) || typeof value.name !== "string") return;
    if (count >= limitCount || depth > 32) { truncated = true; return; } count++;
    const out: Record<string, unknown> = { name: text(value.name, 1024) };
    if (typeof value.detail === "string") out.detail = text(value.detail, 1024);
    if (Number.isInteger(value.kind)) out.kind = value.kind;
    const r = range(value.range); if (r) out.range = r; const sr = range(value.selectionRange); if (sr) out.selectionRange = sr;
    if (record(value.location)) out.location = { uri: typeof value.location.uri === "string" ? text(value.location.uri, 1024) : undefined, range: range(value.location.range) };
    if (Array.isArray(value.children)) out.children = value.children.flatMap((child) => { const normalized = visit(child, depth + 1); return normalized ? [normalized] : []; });
    return out;
  };
  return { symbols: Array.isArray(values) ? values.flatMap((value) => { const item = visit(value, 0); return item ? [item] : []; }) : [], truncated };
}
function boundedTree(value: unknown, state = { nodes: 0, truncated: false }, depth = 0): unknown {
  if (typeof value === "string") return text(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 32 || state.nodes++ >= 1000) { state.truncated = true; return undefined; }
  if (Array.isArray(value)) return value.slice(0, 1000).map((item) => boundedTree(item, state, depth + 1)).filter((item) => item !== undefined);
  if (record(value)) return Object.fromEntries(Object.entries(value).slice(0, 1000).flatMap(([key, item]) => { const bounded = boundedTree(item, state, depth + 1); return bounded === undefined ? [] : [[text(key, 1024), bounded]]; }));
  return undefined;
}

export function registerLspTools(server: McpServer, client: LspToolClient): void {
  registerTool(server, { name: "godot_lsp_diagnostics", description: "Synchronize a script and return bounded pushed diagnostics." + EXCLUSION, inputSchema: z.object({ uri, waitMs: z.number().int().min(100).max(15_000).default(5_000) }).strict(), outputSchema: anyOutput, annotations: LSP_ANNOTATIONS, handler: async (input: any) => { const after = client.diagnostics.sequence; const doc = await client.sync(input.uri); const snapshot = await client.diagnostics.waitFor(doc.uri, doc.generation, after, input.waitMs); return { uri: snapshot.uri, version: doc.version, fresh: snapshot.fresh, diagnostics: snapshot.diagnostics }; } });
  registerTool(server, { name: "godot_lsp_completion", description: "Return bounded completion suggestions without resolving or applying edits." + EXCLUSION, inputSchema: z.object({ uri, position, limit, context: z.object({ triggerKind: z.number().int().min(1).max(3), triggerCharacter: boundedString().optional() }).strict().optional() }).strict(), outputSchema: anyOutput, annotations: LSP_ANNOTATIONS, handler: async (input: any) => { const raw = await positioned(client, input, "completion", "textDocument/completion", input.context ? { context: input.context } : {}); const source = Array.isArray(raw) ? raw : record(raw) && Array.isArray(raw.items) ? raw.items : []; const items = source.slice(0, input.limit).flatMap((item) => { const normalized = completionItem(item); return normalized ? [normalized] : []; }); return { items, truncated: source.length > input.limit }; } });
  registerTool(server, { name: "godot_lsp_hover", description: "Return bounded hover documentation for a script position." + EXCLUSION, inputSchema: z.object({ uri, position }).strict(), outputSchema: anyOutput, annotations: LSP_ANNOTATIONS, handler: async (input: any) => { const raw = await positioned(client, input, "hover", "textDocument/hover"); if (!record(raw)) return { found: false }; const contents = documentation(raw.contents); return { found: true, ...(contents === undefined ? {} : { contents }), ...(range(raw.range) ? { range: range(raw.range) } : {}) }; } });
  registerTool(server, { name: "godot_lsp_signature_help", description: "Return bounded signature help for a script position." + EXCLUSION, inputSchema: z.object({ uri, position }).strict(), outputSchema: anyOutput, annotations: LSP_ANNOTATIONS, handler: async (input: any) => { const raw = await positioned(client, input, "signatureHelp", "textDocument/signatureHelp"); if (!record(raw) || !Array.isArray(raw.signatures)) return { signatures: [] }; return { signatures: raw.signatures.slice(0, 64).flatMap((signature) => !record(signature) || typeof signature.label !== "string" ? [] : [{ label: text(signature.label), ...(documentation(signature.documentation) ? { documentation: documentation(signature.documentation) } : {}), parameters: Array.isArray(signature.parameters) ? signature.parameters.slice(0, 64).flatMap((parameter) => record(parameter) ? [{ label: typeof parameter.label === "string" ? text(parameter.label) : parameter.label, ...(documentation(parameter.documentation) ? { documentation: documentation(parameter.documentation) } : {}) }] : []) : [] }]), ...(Number.isInteger(raw.activeSignature) ? { activeSignature: raw.activeSignature } : {}), ...(Number.isInteger(raw.activeParameter) ? { activeParameter: raw.activeParameter } : {}) }; } });
  registerTool(server, { name: "godot_lsp_document_symbols", description: "Return a bounded hierarchy of symbols in one synchronized script." + EXCLUSION, inputSchema: z.object({ uri }).strict(), outputSchema: anyOutput, annotations: LSP_ANNOTATIONS, handler: async (input: any) => { const doc = await client.sync(input.uri); requireCapability(client, "documentSymbols"); return normalizeSymbols(await client.request("textDocument/documentSymbol", { textDocument: { uri: doc.fileUri } })); } });
  registerTool(server, { name: "godot_lsp_workspace_symbols", description: "Query advertised workspace symbols without fabricating a filesystem index." + EXCLUSION, inputSchema: z.object({ query: boundedString(), limit }).strict(), outputSchema: anyOutput, annotations: LSP_ANNOTATIONS, handler: async (input: any) => { requireCapability(client, "workspaceSymbols"); const normalized = normalizeSymbols(await client.request("workspace/symbol", { query: input.query }), input.limit); return { ...normalized, truncated: normalized.truncated }; } });
  registerTool(server, { name: "godot_lsp_native_symbol", description: "Return bounded native Godot class or member documentation." + EXCLUSION, inputSchema: z.object({ nativeClass: boundedString(), member: boundedString().optional() }).strict(), outputSchema: anyOutput, annotations: LSP_ANNOTATIONS, handler: async (input: any) => { requireCapability(client, "nativeSymbol"); const raw = await client.request<unknown>("textDocument/nativeSymbol", { native_class: input.nativeClass, symbol_name: input.member ?? "" }); if (raw === null) return { found: false }; const state = { nodes: 0, truncated: false }; return { found: true, symbol: boundedTree(raw, state), truncated: state.truncated }; } });
}
