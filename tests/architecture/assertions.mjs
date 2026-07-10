import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectAtlasIds, extractMermaidBlocks } from "../../docs/architecture/render.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/architecture");

export async function assertView(filename, { blockCount = 1, ids, tokens = [] }) {
  const markdown = await readFile(path.join(ROOT, filename), "utf8");
  const blocks = extractMermaidBlocks(markdown);
  assert.equal(blocks.length, blockCount, `${filename}: Mermaid block count`);
  for (const [index, block] of blocks.entries()) {
    assert.match(block, /accTitle:/, `${filename} block ${index + 1}: accTitle`);
    assert.match(block, /accDescr:/, `${filename} block ${index + 1}: accDescr`);
  }
  assert.deepEqual([...collectAtlasIds(blocks)].sort(), [...ids].sort(), `${filename}: atlas IDs`);
  for (const token of tokens) assert.ok(markdown.includes(token), `${filename}: missing ${token}`);
  return markdown;
}
