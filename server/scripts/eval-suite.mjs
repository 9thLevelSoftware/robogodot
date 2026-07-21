/**
 * Phase 8 evaluation suite: cold discovery of tools, resources, and prompts
 * without requiring a live Godot editor.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, PUBLIC_TOOL_COUNT } from "../dist/server.js";
import { ADD_FEATURE_TO_SCENE_PROMPT } from "../dist/prompts/workflows.js";
import { RECONNECT_ACCEPTANCE_MS } from "../dist/bridge/ws-client.js";

process.env.GODOT_MCP_TOKEN ??= "0123456789abcdef0123456789abcdef";

const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) console.log(`PASS ${name}`);
  else {
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
    failures.push(name);
  }
};

const server = createServer({ mode: "read_only" });
const client = new Client({ name: "phase8-eval", version: "1" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

try {
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  check("tool inventory size", tools.length === PUBLIC_TOOL_COUNT, `got ${tools.length}`);
  check("no tool aliases for script", !tools.includes("run_editor_script"));

  const resources = (await client.listResources()).resources.map((resource) => resource.uri);
  for (const uri of ["godot://health", "godot://connection", "godot://mode", "godot://support-matrix"]) {
    check(`resource listed ${uri}`, resources.includes(uri));
  }

  const health = await client.readResource({ uri: "godot://health" });
  const healthJson = JSON.parse(health.contents[0].text);
  check("health has channels", !!healthJson.channels?.editorBridge);

  const matrix = await client.readResource({ uri: "godot://support-matrix" });
  const matrixJson = JSON.parse(matrix.contents[0].text);
  check("support matrix node engine", matrixJson.node === ">=22");
  check("support matrix godot 4.6", Array.isArray(matrixJson.godotMinors) && matrixJson.godotMinors.includes("4.6"));
  check("reconnect acceptance 65s", matrixJson.reconnectAcceptanceMs === RECONNECT_ACCEPTANCE_MS);

  const prompts = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
  check("canonical prompt registered", prompts.includes(ADD_FEATURE_TO_SCENE_PROMPT));
  check("no add-feature alias", !prompts.includes("add-feature"));

  const prompt = await client.getPrompt({
    name: ADD_FEATURE_TO_SCENE_PROMPT,
    arguments: { feature: "Add a Label under the root" },
  });
  check("prompt returns messages", Array.isArray(prompt.messages) && prompt.messages.length >= 1);

  const blocked = await client.callTool({
    name: "godot_fs_write",
    arguments: { path: "res://x.txt", content: "nope" },
  });
  check("read_only blocks fs write", blocked.isError === true);

  check("reconnect constant exported", RECONNECT_ACCEPTANCE_MS === 65_000);
} finally {
  await client.close();
  await server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} evaluation check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nAll Phase 8 evaluation checks passed.");
}
