import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { compositeInputPaths, computeCompositeHash } from "../src/docs/generator-integrity.js";

test("composite hash covers every centralized executable and config input", async () => {
  expect(compositeInputPaths).toEqual(expect.arrayContaining([
    "scripts/generate-doc-index.mjs", "src/docs/class-docs.ts", "src/docs/archive-policy.ts",
    "src/docs/generator-integrity.ts", "docs-generator-config.json", "package-lock.json", "tsconfig.json",
  ]));
  const baseline = Object.fromEntries(compositeInputPaths.map((path) => [path, `content:${path}`]));
  const hash = await computeCompositeHash(async (path) => Buffer.from(baseline[path]!), createHash);
  for (const path of compositeInputPaths) {
    const changed = await computeCompositeHash(async (candidate) => Buffer.from(candidate === path ? `${baseline[candidate]}:changed` : baseline[candidate]!), createHash);
    expect(changed, path).not.toBe(hash);
  }
});

test("composite hash is stable across LF and CRLF checkouts", async () => {
  const lf = Object.fromEntries(compositeInputPaths.map((path) => [path, `first:${path}\nsecond\n`]));
  const crlf = Object.fromEntries(compositeInputPaths.map((path) => [path, lf[path]!.replaceAll("\n", "\r\n")]));

  const lfHash = await computeCompositeHash(async (path) => Buffer.from(lf[path]!), createHash);
  const crlfHash = await computeCompositeHash(async (path) => Buffer.from(crlf[path]!), createHash);

  expect(crlfHash).toBe(lfHash);
});
