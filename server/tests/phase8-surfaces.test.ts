import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer, PUBLIC_TOOL_COUNT, NODE_ENGINE, SUPPORTED_GODOT_MINOR } from "../src/server.js";
import { ADD_FEATURE_TO_SCENE_PROMPT } from "../src/prompts/workflows.js";
import { RECONNECT_ACCEPTANCE_MS, RECONNECT_BACKOFF_MS } from "../src/bridge/ws-client.js";

process.env.GODOT_MCP_TOKEN ??= "0123456789abcdef0123456789abcdef";

async function harness() {
  const server = createServer({ mode: "full" });
  const client = new Client({ name: "phase8", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe("Phase 8 resources and prompts", () => {
  it("lists godot:// resources and returns JSON health and support matrix", async () => {
    const h = await harness();
    try {
      const listed = (await h.client.listResources()).resources.map((resource) => resource.uri).sort();
      expect(listed).toEqual([
        "godot://connection",
        "godot://health",
        "godot://mode",
        "godot://support-matrix",
      ].sort());

      const health = await h.client.readResource({ uri: "godot://health" });
      const healthJson = JSON.parse(health.contents[0]!.text!);
      expect(healthJson).toMatchObject({
        mode: "full",
        channels: expect.objectContaining({ editorBridge: expect.any(String) }),
      });

      const matrix = await h.client.readResource({ uri: "godot://support-matrix" });
      expect(JSON.parse(matrix.contents[0]!.text!)).toMatchObject({
        node: NODE_ENGINE,
        godotMinors: [SUPPORTED_GODOT_MINOR],
        reconnectAcceptanceMs: RECONNECT_ACCEPTANCE_MS,
        publicToolCount: PUBLIC_TOOL_COUNT,
        prompts: [ADD_FEATURE_TO_SCENE_PROMPT],
      });
    } finally {
      await h.close();
    }
  });

  it("registers only add-feature-to-scene and returns a workflow message", async () => {
    const h = await harness();
    try {
      const prompts = (await h.client.listPrompts()).prompts.map((prompt) => prompt.name);
      expect(prompts).toEqual([ADD_FEATURE_TO_SCENE_PROMPT]);
      const prompt = await h.client.getPrompt({
        name: ADD_FEATURE_TO_SCENE_PROMPT,
        arguments: { feature: "Spawn a Camera2D", scenePath: "res://main.tscn" },
      });
      expect(prompt.messages[0]?.content).toMatchObject({ type: "text" });
      expect(String((prompt.messages[0]?.content as { text?: string }).text)).toContain("Camera2D");
      expect(String((prompt.messages[0]?.content as { text?: string }).text)).toContain("godot_node_add");
    } finally {
      await h.close();
    }
  });

  it("defines the 65s reconnect acceptance window above the 60s backoff cap", () => {
    expect(RECONNECT_BACKOFF_MS.at(-1)).toBe(60_000);
    expect(RECONNECT_ACCEPTANCE_MS).toBe(65_000);
  });
});
