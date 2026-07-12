import { createHash } from "node:crypto";
import { open, realpath as fsRealpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GodotMcpError } from "../errors.js";

export const DOCUMENT_LIMITS = { maxUriBytes: 1_024, maxSegments: 128, maxBytes: 2 * 1_024 * 1_024, maxDocuments: 128 } as const;
const MAX_SYNC_GENERATION_ATTEMPTS = 4;
export interface SyncedDocument { uri: string; fileUri: string; path: string; text: string; version: number; generation: number }
export interface LspPosition { line: number; character: number }
interface DocumentSession {
  ensureReady(): Promise<{ generation: number }>;
  notify(method: string, params: unknown): Promise<void>;
  notifyForGeneration?(generation: number, method: string, params: unknown): Promise<void>;
}
type StoredDocument = SyncedDocument & { hash: string };
export interface LspDocumentOptions { realpath?: (path: string) => Promise<string> }

const invalid = (message: string) => new GodotMcpError("invalid_args", message, "Pass a res:// URI for a readable file inside the project root.");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export class LspDocuments {
  private readonly documents = new Map<string, StoredDocument>();
  private realRoot: Promise<string>;
  private readonly canonicalize: (path: string) => Promise<string>;
  constructor(private readonly projectRoot: string, private readonly session: DocumentSession, options: LspDocumentOptions = {}) {
    this.canonicalize = options.realpath ?? fsRealpath; this.realRoot = this.canonicalize(projectRoot);
  }

  async sync(uri: string): Promise<SyncedDocument> {
    const { root, target } = await this.resolveUri(uri);
    const bytes = await this.readAuthorizedTarget(root, target);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw invalid("Document is not valid UTF-8."); }
    const existing = this.documents.get(uri); const contentHash = hash(bytes); const fileUri = pathToFileURL(target).href;
    const initialReady = await this.session.ensureReady();
    if (existing?.hash === contentHash) return this.publicDocument({ ...existing, generation: initialReady.generation });
    if (!existing && this.documents.size >= DOCUMENT_LIMITS.maxDocuments) throw invalid("Synchronized document limit reached.");
    const version = (existing?.version ?? 0) + 1; let ready = initialReady;
    for (let attempt = 1; ; attempt++) {
      const notify = (method: string, params: unknown) => this.session.notifyForGeneration
        ? this.session.notifyForGeneration(ready.generation, method, params)
        : this.session.notify(method, params);
      try {
        if (existing) await notify("textDocument/didChange", { textDocument: { uri: fileUri, version }, contentChanges: [{ text }] });
        else {
          await notify("textDocument/didOpen", { textDocument: { uri: fileUri, languageId: "gdscript", version, text } });
          await notify("textDocument/didChange", { textDocument: { uri: fileUri, version: version + 1 }, contentChanges: [{ text }] });
        }
        await notify("textDocument/didSave", { textDocument: { uri: fileUri }, text });
        break;
      } catch (error) {
        const next = await this.session.ensureReady();
        if (next.generation === ready.generation) throw error;
        if (attempt >= MAX_SYNC_GENERATION_ATTEMPTS) throw new GodotMcpError("not_connected", "Language server generation changed repeatedly during document synchronization.", "Wait for the Godot language server connection to stabilize and retry.");
        ready = next;
      }
    }
    const stored: StoredDocument = { uri, fileUri, path: target, text, version: existing ? version : version + 1, generation: ready.generation, hash: contentHash };
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
    let candidate: string; try { candidate = fileURLToPath(fileUri); } catch { return undefined; }
    for (const document of this.documents.values()) if (document.path === candidate) return document.uri;
    return undefined;
  }

  private async resolveUri(uri: string): Promise<{ root: string; target: string }> {
    if (typeof uri !== "string" || Buffer.byteLength(uri, "utf8") > DOCUMENT_LIMITS.maxUriBytes || !uri.startsWith("res://")) throw invalid("Document URI must be a bounded res:// URI.");
    const encoded = uri.slice(6); if (!encoded || encoded.startsWith("/") || encoded.startsWith("\\")) throw invalid("Document URI must be project-relative.");
    let decoded: string; try { decoded = decodeURIComponent(encoded); } catch { throw invalid("Document URI contains invalid encoding."); }
    if (decoded.includes("\0") || decoded.includes("\\")) throw invalid("Document URI contains an invalid path segment.");
    const segments = decoded.split("/");
    if (segments.length > DOCUMENT_LIMITS.maxSegments || segments.some((part) => part === "" || part === "." || part === "..")) throw invalid("Document URI contains invalid path segments.");
    const root = await this.realRoot.catch(() => { throw invalid("Project root is unavailable."); });
    const candidate = resolve(root, ...segments); if (isAbsolute(decoded)) throw invalid("Document URI must be project-relative.");
    const target = await this.canonicalize(candidate).catch(() => { throw invalid("Document target does not exist."); });
    const rel = relative(root, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw invalid("Document target escapes the project root.");
    if (extname(target) !== ".gd") throw invalid("Document target must have a .gd extension.");
    return { root, target };
  }

  private async readAuthorizedTarget(root: string, target: string): Promise<Buffer> {
    const handle = await open(target, "r").catch(() => { throw invalid("Document target does not exist or cannot be read."); });
    try {
      const info = await handle.stat(); if (!info.isFile()) throw invalid("Document target must be a regular file.");
      // This narrows mutable-path races, but portable Node cannot atomically bind realpath authorization to open(2).
      const revalidated = await this.canonicalize(target).catch(() => { throw invalid("Document target changed during authorization."); });
      const rel = relative(root, revalidated);
      if (revalidated !== target || !rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw invalid("Document target changed during authorization.");
      if (info.size > DOCUMENT_LIMITS.maxBytes) throw invalid("Document exceeds the 2 MiB synchronization limit.");
      const buffer = Buffer.allocUnsafe(DOCUMENT_LIMITS.maxBytes + 1); let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); if (bytesRead === 0) break; offset += bytesRead;
      }
      if (offset > DOCUMENT_LIMITS.maxBytes) throw invalid("Document exceeds the 2 MiB synchronization limit.");
      return buffer.subarray(0, offset);
    } finally { await handle.close(); }
  }

  private publicDocument(document: StoredDocument): SyncedDocument {
    const { hash: _hash, ...result } = document; return result;
  }
}
