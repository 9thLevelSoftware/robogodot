import { createServer, type Server, type Socket } from "node:net";

export interface DecodedFrame { header: string; body: string; json: any }

export function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

export function duplexPair(): { client: Socket; server: Socket } {
  throw new Error("duplexPair is only available asynchronously through MockLspServer");
}

export class MockLspServer {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private readonly handlers = new Map<string, (request: any) => void>();
  readonly messages: any[] = [];
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      let buffer = Buffer.alloc(0);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) break;
          const header = buffer.subarray(0, end).toString("ascii");
          const lengths = header.split("\r\n").filter((line) => /^content-length:/i.test(line));
          if (lengths.length !== 1) { socket.destroy(); return; }
          const raw = lengths[0]!.slice(lengths[0]!.indexOf(":") + 1).trim();
          if (!/^\d+$/.test(raw)) { socket.destroy(); return; }
          const length = Number(raw);
          if (buffer.length < end + 4 + length) break;
          const body = buffer.subarray(end + 4, end + 4 + length);
          buffer = buffer.subarray(end + 4 + length);
          const message = JSON.parse(body.toString("utf8"));
          this.messages.push(message);
          if (typeof message.method === "string" && typeof message.id === "number") this.handlers.get(message.method)?.(message);
        }
      });
    });
    await new Promise<void>((resolve, reject) => this.server!.listen(0, "127.0.0.1", resolve).once("error", reject));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("mock server did not allocate a TCP port");
    this.port = address.port;
  }

  onRequest(method: string, handler: (request: any) => void): void { this.handlers.set(method, handler); }
  result(id: number, result: unknown): void { this.write(frame({ jsonrpc: "2.0", id, result })); }
  error(id: number, code: number, message: string, data?: unknown): void { this.write(frame({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } })); }
  notify(method: string, params?: unknown): void { this.write(frame({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })); }
  sendSplit(message: unknown, cuts: number[]): void {
    const bytes = frame(message); let start = 0;
    for (const end of [...cuts, bytes.length]) { this.write(bytes.subarray(start, Math.min(end, bytes.length))); start = Math.min(end, bytes.length); }
  }
  sendCoalesced(messages: unknown[]): void { this.write(Buffer.concat(messages.map(frame))); }
  sendMalformed(bytes = "Content-Length: 1\r\n\r\n{"): void { this.write(bytes); }
  sendOversized(length = 1_048_577): void { this.write(`Content-Length: ${length}\r\n\r\n`); }
  sendRaw(bytes: Buffer | string): void { this.write(bytes); }
  private write(bytes: Buffer | string): void { for (const socket of this.sockets) socket.write(bytes); }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
