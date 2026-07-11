import type { Readable } from "node:stream";

export interface OutputCapture {
  diagnostics(): string;
  dispose(): void;
}

export function captureBoundedOutput(stdout: Readable, stderr: Readable, limit = 16_384): OutputCapture {
  let out = Buffer.alloc(0);
  let err = Buffer.alloc(0);
  const append = (current: Buffer, chunk: unknown): Buffer => {
    const next = Buffer.concat([current, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
    return next.length > limit ? next.subarray(next.length - limit) : next;
  };
  const onStdout = (chunk: unknown) => { out = append(out, chunk); };
  const onStderr = (chunk: unknown) => { err = append(err, chunk); };
  stdout.on("data", onStdout);
  stderr.on("data", onStderr);
  return {
    diagnostics: () => `stdout: ${out.toString("utf8")}\nstderr: ${err.toString("utf8")}`,
    dispose: () => {
      stdout.off("data", onStdout);
      stderr.off("data", onStderr);
    },
  };
}

export async function launchWithPortRetry<T>(options: {
  attempts: number;
  allocatePort(): Promise<number>;
  launch(port: number): T;
  waitUntilConnected(process: T): Promise<void>;
  terminate(process: T): Promise<void>;
  diagnostics(process: T): string;
}): Promise<T> {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    const port = await options.allocatePort();
    const process = options.launch(port);
    try {
      await options.waitUntilConnected(process);
      return process;
    } catch (error) {
      failures.push(`attempt ${attempt}/${options.attempts}: ${error instanceof Error ? error.message : String(error)}\n${options.diagnostics(process)}`);
      await options.terminate(process);
    }
  }
  throw new Error(`Godot failed to launch after ${options.attempts} attempts\n${failures.join("\n")}`);
}
