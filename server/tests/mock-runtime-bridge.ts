import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { createHmac, randomBytes } from "node:crypto";
import { encodeFrame, FrameDecoder } from "../src/runtime/bridge-protocol.js";

interface Options { sessionId: string; token: string; hold?: boolean; sessionRoot?: string; forgedAck?: boolean }
export class MockRuntimeBridge {
  port = 0; connections = 0; requests: Record<string, any>[] = []; ids: number[] = []; beforeResponse?: (request: Record<string, any>) => Record<string, any>[];
  private server?: Server; private sockets = new Set<Socket>(); private timer?: NodeJS.Timeout;
  private polling = false;
  private constructor(private options: Options) {}
  static async socket(options: Options) { const self = new MockRuntimeBridge(options); await self.listen(); return self; }
  static async file(options: Options) { const self = new MockRuntimeBridge(options); self.poll(); return self; }
  async close() { if (this.timer) clearInterval(this.timer); for (const s of this.sockets) s.destroy(); await new Promise<void>(r => this.server ? this.server.close(() => r()) : r()); }
  private async listen() { this.server = createServer(socket => { this.connections++; this.sockets.add(socket); const d = new FrameDecoder(); let authenticated = false; socket.on("data", chunk => { for (const raw of d.push(Buffer.from(chunk))) { const v = raw as Record<string, any>; if (!authenticated) { const expected = proof(this.options.token, "robogodot-client-v1", this.options.sessionId, 1, v.clientNonce); if (v.type === "hello" && v.version === 1 && v.sessionId === this.options.sessionId && v.clientProof === expected) { authenticated = true; const serverNonce = randomBytes(32).toString("hex"); const serverProof = this.options.forgedAck ? "0".repeat(64) : proof(this.options.token, "robogodot-server-v1", this.options.sessionId, 1, v.clientNonce, serverNonce); socket.write(encodeFrame({ type: "hello_ack", version: 1, sessionId: this.options.sessionId, clientNonce: v.clientNonce, serverNonce, serverProof })); } else socket.destroy(); continue; } void this.respond(v, x => socket.write(encodeFrame(x))); } }); }); await new Promise<void>(r => this.server!.listen(0, "127.0.0.1", r)); this.port = (this.server.address() as any).port; }
  private poll() { this.timer = setInterval(async () => { if (this.polling) return; this.polling = true; try { for (const name of await readdir(this.options.sessionRoot!)) if (/^req-\d+\.json$/.test(name)) { const path = `${this.options.sessionRoot}/${name}`; const v = JSON.parse(await readFile(path, "utf8")); await unlink(path); await this.respond(v, x => writeFile(`${this.options.sessionRoot}/resp-${v.id}.json`, JSON.stringify(x))); } } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } finally { this.polling = false; } }, 5); }
  private async respond(v: Record<string, any>, send: (value: object) => any) { if (v.token !== this.options.token || v.sessionId !== this.options.sessionId || v.version !== 1) return; this.requests.push(v); this.ids.push(v.id); if (this.options.hold) return; for (const extra of this.beforeResponse?.(v) ?? []) await send(extra); await send({ type: "response", version: 1, sessionId: this.options.sessionId, id: v.id, result: { ok: true } }); }
}

function proof(token: string, label: string, session: string, version: number, ...nonces: string[]) { return createHmac("sha256", token).update([label, session, String(version), ...nonces].join("\0")).digest("hex"); }
