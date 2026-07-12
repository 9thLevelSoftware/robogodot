import type { LspCapability, LspNotification } from "./protocol.js";
import { LspDiagnostics } from "./diagnostics.js";
import { LspDocuments, type LspPosition, type SyncedDocument } from "./documents.js";
import { LspSession } from "./session.js";

export class LspClient {
  readonly documents: LspDocuments;
  readonly diagnostics: LspDiagnostics;
  private readonly unsubscribe: () => void;
  constructor(projectRoot: string, private readonly session: LspSession) {
    this.documents = new LspDocuments(projectRoot, session);
    this.diagnostics = new LspDiagnostics((uri) => this.documents.publicUriForFileUri(uri) ?? uri);
    this.unsubscribe = session.onNotification((event: LspNotification) => this.diagnostics.accept(event));
    session.setReplayHook((generation) => this.documents.replay(generation));
  }
  async sync(uri: string): Promise<SyncedDocument> { const document = await this.documents.sync(uri); this.diagnostics.remap(document.fileUri, document.uri); return document; }
  assertPosition(document: SyncedDocument, position: LspPosition): void { this.documents.assertPosition(document, position); }
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> { return this.session.request<T>(method, params, timeoutMs); }
  supports(capability: LspCapability): boolean { return this.session.supports(capability); }
  ensureReady() { return this.session.ensureReady(); }
  async close(): Promise<void> { this.unsubscribe(); this.diagnostics.close(); await this.session.close(); }
}
