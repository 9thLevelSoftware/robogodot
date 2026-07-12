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
  ensureReady(): Promise<unknown>;
}

const LSP_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const EXCLUSION = " Godot LSP support is partial; this tool does not expose rename, formatting, or code actions.";
interface NormalizationState { truncated: boolean }
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const own = (value: Record<string, unknown>, key: string): unknown => { try { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && "value" in descriptor ? descriptor.value : undefined; } catch { return undefined; } };
const field = (value: Record<string, unknown>, key: string, state: NormalizationState): unknown => { try { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor) return undefined; if (!("value" in descriptor)) { state.truncated = true; return undefined; } return descriptor.value; } catch { state.truncated = true; return undefined; } };
const arrayLength = (value: unknown[]): number | undefined => { try { const descriptor = Object.getOwnPropertyDescriptor(value, "length"); const length = descriptor && "value" in descriptor ? descriptor.value : undefined; return Number.isSafeInteger(length) && (length as number) >= 0 ? length as number : undefined; } catch { return undefined; } };
const arrayValues = (value: unknown[], limitCount = 1000): { values: unknown[]; omitted: boolean } => {
  const values: unknown[] = []; const length = arrayLength(value); if (length === undefined) return { values, omitted: true }; let omitted = length > limitCount;
  for (let index = 0; index < Math.min(length, limitCount); index++) { try { const descriptor = Object.getOwnPropertyDescriptor(value, String(index)); if (descriptor && "value" in descriptor) values.push(descriptor.value); else omitted = true; } catch { omitted = true; } }
  return { values, omitted };
};
const boundedString = (max = 1024) => z.string().refine((value) => Buffer.byteLength(value, "utf8") <= max, `Must be at most ${max} UTF-8 bytes.`);
const uri = boundedString();
const position = z.object({ line: z.number().int().min(0).max(1_000_000), character: z.number().int().min(0).max(1_000_000) }).strict();
const limit = z.number().int().min(1).max(500).default(500);
const anyOutput = z.object({}).catchall(z.unknown());
const text = (value: string, max = 8192, state?: NormalizationState): string => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= max) return value;
  if (state) state.truncated = true;
  let end = max; while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
};
const documentation = (value: unknown, state: NormalizationState): string | undefined => {
  if (typeof value === "string") return text(value, 8192, state);
  if (record(value)) { const contents = own(value, "value"); if (typeof contents === "string") return text(contents, 8192, state); state.truncated = true; return undefined; }
  if (Array.isArray(value)) { const safe = arrayValues(value, 256); if (safe.omitted) state.truncated = true; const parts = safe.values.flatMap((item) => { if (typeof item === "string") return [item]; if (record(item)) { const contents = own(item, "value"); if (typeof contents === "string") return [contents]; } state.truncated = true; return []; }); return text(parts.join("\n"), 8192, state); }
  if (value !== undefined && value !== null) state.truncated = true;
};
const documentationBytes = (value: unknown): number => {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (record(value)) { const contents = own(value, "value"); return typeof contents === "string" ? Buffer.byteLength(contents, "utf8") : 0; }
  if (Array.isArray(value)) return Buffer.byteLength(arrayValues(value, 256).values.flatMap((item) => typeof item === "string" ? [item] : record(item) && typeof own(item, "value") === "string" ? [own(item, "value") as string] : []).join("\n"), "utf8");
  return 0;
};
const remotePosition = (value: unknown, state: NormalizationState): LspPosition | undefined => record(value)
  && Number.isInteger(own(value, "line")) && (own(value, "line") as number) >= 0 && (own(value, "line") as number) <= 1_000_000
  && Number.isInteger(own(value, "character")) && (own(value, "character") as number) >= 0 && (own(value, "character") as number) <= 1_000_000
  ? { line: own(value, "line") as number, character: own(value, "character") as number } : (state.truncated = true, undefined);
const range = (value: unknown, state: NormalizationState): unknown => {
  if (!record(value)) { state.truncated = true; return undefined; } const start = remotePosition(own(value, "start"), state); const end = remotePosition(own(value, "end"), state);
  return start && end ? { start, end } : undefined;
};

function requireCapability(client: LspToolClient, capability: LspCapability): void {
  if (!client.supports(capability)) throw new GodotMcpError("feature_disabled", `The connected Godot language server does not advertise ${capability}.`, capability === "workspaceSymbols" ? "Godot 4.6 does not register workspace/symbol; use document symbols for a specific res:// script." : "Use a Godot version that advertises this LSP capability.");
}
async function positioned(client: LspToolClient, input: { uri: string; position: LspPosition }, capability: LspCapability, method: string, extra: Record<string, unknown> = {}) {
  const document = await client.sync(input.uri); client.assertPosition(document, input.position); requireCapability(client, capability);
  return client.request<unknown>(method, { textDocument: { uri: document.fileUri }, position: input.position, ...extra });
}
function completionItem(value: unknown, state: NormalizationState): Record<string, unknown> | undefined {
  if (!record(value) || typeof own(value, "label") !== "string") return;
  const rawLabel = own(value, "label") as string;
  const out: Record<string, unknown> = { label: text(rawLabel.replace(/\((?:…)?\)$/, ""), 1024, state) };
  for (const key of ["detail", "insertText", "sortText", "filterText"] as const) { const itemField = field(value, key, state); if (typeof itemField === "string") out[key] = text(itemField, 1024, state); else if (itemField !== undefined) state.truncated = true; }
  const kind = field(value, "kind", state); if (Number.isInteger(kind)) out.kind = kind; else if (kind !== undefined) state.truncated = true;
  const rawDocs = field(value, "documentation", state); if (rawDocs !== undefined) { const docs = documentation(rawDocs, state); if (docs !== undefined) out.documentation = docs; }
  const edit = field(value, "textEdit", state); if (edit !== undefined) { if (record(edit) && typeof field(edit, "newText", state) === "string") { const editRange = range(field(edit, "range", state), state); if (editRange) out.textEdit = { range: editRange, newText: text(field(edit, "newText", state) as string, 1024, state) }; else state.truncated = true; } else state.truncated = true; }
  return out;
}
function normalizeSymbols(values: unknown, limitCount = 1000): { symbols: Record<string, unknown>[]; truncated: boolean } {
  let count = 0; const state: NormalizationState = { truncated: false };
  const visit = (value: unknown, depth: number): Record<string, unknown> | undefined => {
    if (!record(value) || typeof own(value, "name") !== "string") { state.truncated = true; return; }
    if (count >= limitCount || depth > 32) { state.truncated = true; return; } count++;
    const out: Record<string, unknown> = { name: text(own(value, "name") as string, 1024, state) };
    const detail = field(value, "detail", state); if (typeof detail === "string") out.detail = text(detail, 1024, state); else if (detail !== undefined) state.truncated = true;
    const kind = field(value, "kind", state); if (Number.isInteger(kind)) out.kind = kind; else if (kind !== undefined) state.truncated = true;
    const rawRange = field(value, "range", state); if (rawRange !== undefined) { const r = range(rawRange, state); if (r) out.range = r; } const rawSelection = field(value, "selectionRange", state); if (rawSelection !== undefined) { const sr = range(rawSelection, state); if (sr) out.selectionRange = sr; }
    const location = field(value, "location", state); if (location !== undefined) { if (record(location)) { const locationUri = field(location, "uri", state); const locationRange = range(field(location, "range", state), state); if (typeof locationUri === "string" && Buffer.byteLength(locationUri, "utf8") <= 1024 && locationRange) out.location = { uri: locationUri, range: locationRange }; else state.truncated = true; } else state.truncated = true; }
    const children = field(value, "children", state); if (Array.isArray(children)) { const safe = arrayValues(children, 1000); if (safe.omitted) state.truncated = true; out.children = safe.values.flatMap((child) => { const normalized = visit(child, depth + 1); return normalized ? [normalized] : []; }); } else if (children !== undefined) state.truncated = true;
    return out;
  };
  const safe = Array.isArray(values) ? arrayValues(values, Math.max(limitCount, 1000)) : { values: [], omitted: values !== null && values !== undefined }; if (safe.omitted) state.truncated = true;
  return { symbols: safe.values.flatMap((value) => { const item = visit(value, 0); return item ? [item] : []; }), truncated: state.truncated };
}
function normalizeSignatures(raw: unknown): Record<string, unknown> {
  const flags = { signatures: false, parameters: false, malformed: false, strings: false };
  if (!record(raw)) return { signatures: [], truncated: false, truncation: flags };
  const rootState = { truncated: false }; const source = field(raw, "signatures", rootState); if (!Array.isArray(source)) { flags.malformed = rootState.truncated || source !== undefined; return { signatures: [], truncated: flags.malformed, truncation: flags }; }
  const safeSignatures = arrayValues(source, 64); flags.signatures = safeSignatures.omitted;
  const signatures = safeSignatures.values.flatMap((signature): Record<string, unknown>[] => {
    if (!record(signature) || typeof own(signature, "label") !== "string") { flags.malformed = true; return []; }
    const rawLabel = own(signature, "label") as string; if (Buffer.byteLength(rawLabel, "utf8") > 8192) flags.strings = true;
    const stringState = { truncated: false }; const result: Record<string, unknown> = { label: text(rawLabel, 8192, stringState) }; const docsValue = field(signature, "documentation", stringState); const docs = documentation(docsValue, stringState);
    if (docs !== undefined) { if (documentationBytes(docsValue) > 8192 || stringState.truncated) flags.strings = true; result.documentation = docs; }
    const rawParameters = field(signature, "parameters", stringState); const parameters: Record<string, unknown>[] = [];
    if (Array.isArray(rawParameters)) {
      const safeParameters = arrayValues(rawParameters, 64); if (safeParameters.omitted) flags.parameters = true;
      for (const parameter of safeParameters.values) {
        if (!record(parameter)) { flags.malformed = true; continue; } const parameterState = { truncated: false }; const label = field(parameter, "label", parameterState); let normalizedLabel: string | [number, number] | undefined;
        if (typeof label === "string") { if (Buffer.byteLength(label, "utf8") > 8192) flags.strings = true; normalizedLabel = text(label); }
        else if (Array.isArray(label) && arrayLength(label) === 2) { const parts = arrayValues(label, 2).values; if (parts.length === 2 && parts.every((part) => Number.isInteger(part) && (part as number) >= 0 && (part as number) <= 1_000_000)) normalizedLabel = [parts[0] as number, parts[1] as number]; }
        if (normalizedLabel === undefined) { flags.malformed = true; continue; } const normalized: Record<string, unknown> = { label: normalizedLabel }; const rawParameterDocs = field(parameter, "documentation", parameterState); const parameterDocs = documentation(rawParameterDocs, parameterState); if (parameterDocs !== undefined) { if (documentationBytes(rawParameterDocs) > 8192) flags.strings = true; normalized.documentation = parameterDocs; } if (parameterState.truncated) flags.malformed = true; parameters.push(normalized);
      }
    }
    result.parameters = parameters; return [result];
  });
  if (rootState.truncated) flags.malformed = true; const activeSignature = field(raw, "activeSignature", rootState); const activeParameter = field(raw, "activeParameter", rootState); if (rootState.truncated) flags.malformed = true;
  return { signatures, ...(Number.isInteger(activeSignature) ? { activeSignature } : {}), ...(Number.isInteger(activeParameter) ? { activeParameter } : {}), truncated: Object.values(flags).some(Boolean), truncation: flags };
}
function boundedTree(value: unknown, state = { nodes: 0, truncated: false }, depth = 0): unknown {
  if (typeof value === "string") return text(value, 8192, state);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") { if (Number.isFinite(value)) return value; state.truncated = true; return undefined; }
  if (depth > 32 || state.nodes++ >= 1000) { state.truncated = true; return undefined; }
  if (Array.isArray(value)) { const safe = arrayValues(value, 1000); if (safe.omitted) state.truncated = true; return safe.values.map((item) => boundedTree(item, state, depth + 1)).filter((item) => item !== undefined); }
  if (record(value)) { let names: string[]; try { names = Object.getOwnPropertyNames(value); } catch { state.truncated = true; return undefined; } if (names.length > 1000) state.truncated = true; return Object.fromEntries(names.slice(0, 1000).flatMap((key) => { try { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !("value" in descriptor)) { state.truncated = true; return []; } const bounded = boundedTree(descriptor.value, state, depth + 1); return bounded === undefined ? [] : [[text(key, 1024, state), bounded]]; } catch { state.truncated = true; return []; } })); }
  state.truncated = true; return undefined;
}

export function registerLspTools(server: McpServer, client: LspToolClient): void {
  registerTool(server, { name: "godot_lsp_diagnostics", description: "Synchronize a script and return bounded pushed diagnostics." + EXCLUSION, inputSchema: z.object({ uri, waitMs: z.number().int().min(100).max(15_000).default(5_000) }).strict(), outputSchema: anyOutput, annotations: LSP_ANNOTATIONS, handler: async (input: any) => {
    const started = Date.now(); const after = client.diagnostics.sequence; const doc = await client.sync(input.uri);
    let snapshot = await client.diagnostics.waitFor(doc.uri, doc.generation, after, input.waitMs);
    while (snapshot.diagnostics.length === 0) {
      const remaining = input.waitMs - (Date.now() - started); if (remaining < 100) break;
      const next = await client.diagnostics.waitFor(doc.uri, doc.generation, snapshot.sequence, remaining);
      if (next.sequence <= snapshot.sequence) { snapshot = next; break; } snapshot = next;
    }
    return { uri: snapshot.uri, version: doc.version, fresh: snapshot.fresh, diagnostics: snapshot.diagnostics, truncated: snapshot.truncated ?? false, truncation: snapshot.truncation ?? { diagnostics: false, tags: false, relatedInformation: false, strings: false, positions: false, malformed: false } };
  } });
  registerTool(server, { name: "godot_lsp_completion", description: "Return bounded completion suggestions without resolving or applying edits." + EXCLUSION, inputSchema: z.object({ uri, position, limit, context: z.object({ triggerKind: z.number().int().min(1).max(3), triggerCharacter: boundedString().optional() }).strict().optional() }).strict(), outputSchema: anyOutput, annotations: LSP_ANNOTATIONS, handler: async (input: any) => { const raw = await positioned(client, input, "completion", "textDocument/completion", input.context ? { context: input.context } : {}); const state: NormalizationState = { truncated: false }; const sourceValue = Array.isArray(raw) ? raw : record(raw) ? field(raw, "items", state) : undefined; const safe = Array.isArray(sourceValue) ? arrayValues(sourceValue, input.limit) : { values: [], omitted: sourceValue !== null && sourceValue !== undefined }; state.truncated ||= safe.omitted; const items = safe.values.flatMap((item) => { const normalized = completionItem(item, state); if (!normalized) state.truncated = true; return normalized ? [normalized] : []; }); return { items, truncated: state.truncated }; } });
  registerTool(server, { name: "godot_lsp_hover", description: "Return bounded hover documentation for a script position." + EXCLUSION, inputSchema: z.object({ uri, position }).strict(), outputSchema: anyOutput, annotations: LSP_ANNOTATIONS, handler: async (input: any) => { const raw = await positioned(client, input, "hover", "textDocument/hover"); if (!record(raw)) return { found: false, truncated: raw !== null }; const state: NormalizationState = { truncated: false }; const contents = documentation(field(raw, "contents", state), state); if (contents === undefined) return { found: false, truncated: true }; const rawRange = field(raw, "range", state); const hoverRange = rawRange === undefined ? undefined : range(rawRange, state); return { found: true, contents, ...(hoverRange ? { range: hoverRange } : {}), truncated: state.truncated }; } });
  registerTool(server, { name: "godot_lsp_signature_help", description: "Return bounded signature help for a script position." + EXCLUSION, inputSchema: z.object({ uri, position }).strict(), outputSchema: anyOutput, annotations: LSP_ANNOTATIONS, handler: async (input: any) => { const raw = await positioned(client, input, "signatureHelp", "textDocument/signatureHelp"); return normalizeSignatures(raw); } });
  registerTool(server, { name: "godot_lsp_document_symbols", description: "Return a bounded hierarchy of symbols in one synchronized script." + EXCLUSION, inputSchema: z.object({ uri }).strict(), outputSchema: anyOutput, annotations: LSP_ANNOTATIONS, handler: async (input: any) => { const doc = await client.sync(input.uri); requireCapability(client, "documentSymbols"); return normalizeSymbols(await client.request("textDocument/documentSymbol", { textDocument: { uri: doc.fileUri } })); } });
  registerTool(server, { name: "godot_lsp_workspace_symbols", description: "Query advertised workspace symbols without fabricating a filesystem index." + EXCLUSION, inputSchema: z.object({ query: boundedString(), limit }).strict(), outputSchema: anyOutput, annotations: LSP_ANNOTATIONS, handler: async (input: any) => { await client.ensureReady(); requireCapability(client, "workspaceSymbols"); const normalized = normalizeSymbols(await client.request("workspace/symbol", { query: input.query }), input.limit); return { ...normalized, truncated: normalized.truncated }; } });
  registerTool(server, { name: "godot_lsp_native_symbol", description: "Return bounded native Godot class or member documentation." + EXCLUSION, inputSchema: z.object({ nativeClass: boundedString(), member: boundedString().optional() }).strict(), outputSchema: anyOutput, annotations: LSP_ANNOTATIONS, handler: async (input: any) => { await client.ensureReady(); requireCapability(client, "nativeSymbol"); const raw = await client.request<unknown>("textDocument/nativeSymbol", { native_class: input.nativeClass, symbol_name: input.member ?? "" }); if (raw === null) return { found: false }; if (!record(raw) && !Array.isArray(raw)) throw new GodotMcpError("godot_error", "Godot returned an invalid native symbol response.", "Check that the Godot language server and MCP server versions are compatible."); const state = { nodes: 0, truncated: false }; const symbol = boundedTree(raw, state); if (symbol === undefined || (record(symbol) && Object.keys(symbol).length === 0)) throw new GodotMcpError("godot_error", "Godot returned an invalid native symbol response.", "Check that the Godot language server and MCP server versions are compatible."); return { found: true, symbol, truncated: state.truncated }; } });
}
