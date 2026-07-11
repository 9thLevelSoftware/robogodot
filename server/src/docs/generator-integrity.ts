import type { createHash as nodeCreateHash } from "node:crypto";

export const compositeInputPaths = [
  "scripts/generate-doc-index.mjs",
  "src/docs/class-docs.ts",
  "src/docs/archive-policy.ts",
  "src/docs/generator-integrity.ts",
  "docs-generator-config.json",
  "package-lock.json",
  "tsconfig.json",
] as const;

function normalizeCheckoutLineEndings(contents: Buffer): Buffer {
  if (!contents.includes(0x0d)) return contents;
  const normalized = Buffer.allocUnsafe(contents.length);
  let outputIndex = 0;
  for (let inputIndex = 0; inputIndex < contents.length; inputIndex += 1) {
    const byte = contents[inputIndex]!;
    if (byte === 0x0d && contents[inputIndex + 1] === 0x0a) continue;
    normalized[outputIndex] = byte;
    outputIndex += 1;
  }
  return normalized.subarray(0, outputIndex);
}

export async function computeCompositeHash(
  read: (relativePath: string) => Promise<Buffer>,
  createHash: typeof nodeCreateHash,
): Promise<string> {
  const composite = createHash("sha256");
  for (const path of compositeInputPaths) {
    composite.update(path).update("\0").update(normalizeCheckoutLineEndings(await read(path))).update("\0");
  }
  return composite.digest("hex");
}
