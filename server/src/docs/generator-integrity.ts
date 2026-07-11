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

export async function computeCompositeHash(
  read: (relativePath: string) => Promise<Buffer>,
  createHash: typeof nodeCreateHash,
): Promise<string> {
  const composite = createHash("sha256");
  for (const path of compositeInputPaths) composite.update(path).update("\0").update(await read(path)).update("\0");
  return composite.digest("hex");
}
