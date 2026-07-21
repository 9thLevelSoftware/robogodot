import { createServer, type Server, type Socket } from "node:net";

export function dapFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

export class MockDapServer {
  readonly messages: any[] = [];
  readonly spawnCalls: unknown[] = [];
  private server: Server | undefined;
  private socket: Socket | undefined;
  private buffer = Buffer.alloc(0);
  private bodyLength: number | undefined;
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((socket) => { this.socket = socket; socket.on("data", (chunk) => this.read(chunk)); });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
  }
  respond(request: any, body: unknown = {}): void { this.send({ seq: 10_000 + request.seq, type: "response", request_seq: request.seq, success: true, command: request.command, body }); }
  error(request: any, message: string): void { this.send({ seq: 10_000 + request.seq, type: "response", request_seq: request.seq, success: false, command: request.command, message }); }
  event(event: string, body?: unknown): void { this.send({ seq: 20_000 + this.messages.length, type: "event", event, ...(body === undefined ? {} : { body }) }); }
  send(message: unknown): void { this.socket?.write(dapFrame(message)); }
  sendRaw(bytes: string | Buffer): void { this.socket?.write(bytes); }
  sendSplit(message: unknown, points: number[]): void { const frame = dapFrame(message); let start = 0; for (const point of points) { this.socket?.write(frame.subarray(start, point)); start = point; } this.socket?.write(frame.subarray(start)); }
  sendCoalesced(messages: unknown[]): void { this.socket?.write(Buffer.concat(messages.map(dapFrame))); }
  async stop(): Promise<void> { this.socket?.destroy(); await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve()); }
  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      if (this.bodyLength === undefined) { const end = this.buffer.indexOf("\r\n\r\n"); if (end < 0) return; const match = /Content-Length: (\d+)/i.exec(this.buffer.subarray(0, end).toString("ascii")); if (!match) { this.socket?.destroy(); return; } this.bodyLength = Number(match[1]); this.buffer = this.buffer.subarray(end + 4); }
      if (this.buffer.length < this.bodyLength) return;
      const body = this.buffer.subarray(0, this.bodyLength); this.buffer = this.buffer.subarray(this.bodyLength); this.bodyLength = undefined;
      this.messages.push(JSON.parse(body.toString("utf8")));
    }
  }
}
