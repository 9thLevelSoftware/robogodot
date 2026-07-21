import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Sole public prompt name (ADR 0006 / Q-014). No aliases.
 */
export const ADD_FEATURE_TO_SCENE_PROMPT = "add-feature-to-scene" as const;

export function registerWorkflowPrompts(server: McpServer): void {
  server.registerPrompt(ADD_FEATURE_TO_SCENE_PROMPT, {
    title: "Add feature to scene",
    description: "Orchestrate a Tier A scene feature using curated Godot Control MCP tools, then verify with tree and optional LSP diagnostics.",
    argsSchema: {
      feature: z.string().min(1).describe("Short description of the feature to add"),
      scenePath: z.string().optional().describe("Optional res:// path of the scene to edit"),
      rootHint: z.string().optional().describe("Optional NodePath hint for where to attach new nodes"),
    },
  }, ({ feature, scenePath, rootHint }) => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: [
          "You are controlling a Godot 4.6 project through Godot Control MCP.",
          "Use only public tools (no aliases). Prefer curated Tier A mutations over godot_script_run.",
          "Respect GODOT_MCP_MODE: in confirm_destructive pass confirmed:true for destructive tools; never use godot_script_run unless mode is full and allowDangerous is true after review.",
          "",
          `Feature request: ${feature}`,
          scenePath ? `Target scene: ${scenePath}` : "Target scene: use godot_scene_current / godot_scene_open as needed.",
          rootHint ? `Attachment hint: ${rootHint}` : "Attachment hint: choose a sensible parent from godot_scene_tree.",
          "",
          "Suggested workflow:",
          "1. godot_connection_status / godot_ping until connected.",
          "2. godot_scene_current (and godot_scene_open if needed).",
          "3. godot_scene_tree to locate parents.",
          "4. Add nodes with godot_node_add / godot_scene_instance; set properties with godot_node_set_property.",
          "5. Wire signals with godot_signal_connect when needed.",
          "6. Verify with godot_scene_tree and godot_node_get.",
          "7. Persist explicitly with godot_scene_save only when the user wants disk changes.",
          "8. If scripts are involved, use godot_lsp_diagnostics on the res:// .gd path after disk writes.",
          "9. Prefer undoing via the editor for in-memory mistakes (each curated mutation is one UndoRedo action).",
        ].join("\n"),
      },
    }],
  }));
}
