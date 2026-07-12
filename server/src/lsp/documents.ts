import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { GodotMcpError } from "../errors.js";

export const DOCUMENT_LIMITS = { maxUriBytes: 1_024, maxSegments: 128, maxBytes: 2 * 1_024 * 1_024, maxDocuments: 128 } as const;
export interface SyncedDocument { uri: string; fileUri: string; path: string; text: string; version: number; generation: number }
export interface LspPosition { line: number; character: number }
interface DocumentSession {
  ensureReady(): Promise<{ generation: number }>;
  notify(method: string, params: unknown): Promise<void>;
  notifyForGeneration?(generation: number, method: string, params: unknown): Promise<void>;
}
type StoredDocument = SyncedDocument & { hash: string };

const invalid = (message: string) => new GodotMcpError("invalid_args", message, "Pass a res:// URI for a readable file inside the project root.");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export class LspDocuments {
  private readonly documents = new Map<string, StoredDocument>();
  private realRoot: Promise<string>;
  constructor(private readonly projectRoot: string, private readonly session: DocumentSession) { this.realRoot = realpath(projectRoot); }

  async sync(uri: string): Promise<SyncedDocument> {
    const target = await this.resolveUri(uri);
    const bytes = await readFile(target).catch(() => { throw invalid("Document target does not exist or cannot be read."); });
    if (bytes.length > DOCUMENT_LIMITS.maxBytes) throw invalid("Document exceeds the 2 MiB synchronization limit.");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw invalid("Document is not valid UTF-8."); }
    const ready = await this.session.ensureReady();
    const existing = this.documents.get(uri); const contentHash = hash(bytes); const fileUri = pathToFileURL(target).href;
    if (existing?.hash === contentHash) return this.publicDocument({ ...existing, generation: ready.generation });
    if (!existing && this.documents.size >= DOCUMENT_LIMITS.maxDocuments) throw invalid("Synchronized document limit reached.");
    const version = (existing?.version ?? 0) + 1;
    if (existing) await this.session.notify("textDocument/didChange", { textDocument: { uri: fileUri, version }, contentChanges: [{ text }] });
    else await this.session.notify("textDocument/didOpen", { textDocument: { uri: fileUri, languageId: "gdscript", version, text } });
    const stored: StoredDocument = { uri, fileUri, path: target, text, version, generation: ready.generation, hash: contentHash };
    this.documents.set(uri, stored); return this.publicDocument(stored);
  }

  assertPosition(document: SyncedDocument, position: LspPosition): void {
    if (!Number.isInteger(position.line) || !Number.isInteger(position.character) || position.line < 0 || position.character < 0) throw invalid("LSP position must contain non-negative integer offsets.");
    const lines = document.text.split(/\r\n|\r|\n/);
    const line = lines[position.line];
    if (line === undefined || position.character > line.length) throw invalid("LSP position is outside the synchronized document.");
  }

  async replay(generation: number): Promise<void> {
    const notify = this.session.notifyForGeneration
      ? (method: string, params: unknown) => this.session.notifyForGeneration!(generation, method, params)
      : (method: string, params: unknown) => this.session.notify(method, params);
    for (const document of [...this.documents.values()].sort((a, b) => a.uri.localeCompare(b.uri))) {
      await notify("textDocument/didOpen", { textDocument: { uri: document.fileUri, languageId: "gdscript", version: document.version, text: document.text } });
      document.generation = generation;
    }
  }

  publicUriForFileUri(fileUri: string): string | undefined {
    for (const document of this.documents.values()) if (document.fileUri === fileUri) return document.uri;
    return undefined;
  }

  private async resolveUri(uri: string): Promise<string> {
    if (typeof uri !== "string" || Buffer.byteLength(uri, "utf8") > DOCUMENT_LIMITS.maxUriBytes || !uri.startsWith("res://")) throw invalid("Document URI must be a bounded res:// URI.");
    const encoded = uri.slice(6); if (!encoded || encoded.startsWith("/") || encoded.startsWith("\\")) throw invalid("Document URI must be project-relative.");
    let decoded: string; try { decoded = decodeURIComponent(encoded); } catch { throw invalid("Document URI contains invalid encoding."); }
    if (decoded.includes("\0") || decoded.includes("\\")) throw invalid("Document URI contains an invalid path segment.");
    const segments = decoded.split("/");
    if (segments.length > DOCUMENT_LIMITS.maxSegments || segments.some((part) => part === "" || part === "." || part === "..")) throw invalid("Document URI contains invalid path segments.");
    const root = await this.realRoot.catch(() => { throw invalid("Project root is unavailable."); });
    const candidate = resolve(root, ...segments); if (isAbsolute(decoded)) throw invalid("Document URI must be project-relative.");
    const target = await realpath(candidate).catch(() => { throw invalid("Document target does not exist."); });
    const info = await stat(target).catch(() => { throw invalid("Document target is unavailable."); }); if (!info.isFile()) throw invalid("Document target must be a file.");
    const rel = relative(root, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw invalid("Document target escapes the project root.");
    return target;
  }

  private publicDocument(document: StoredDocument): SyncedDocument {
    const { hash: _hash, ...result } = document; return result;
  }
}
