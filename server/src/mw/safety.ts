import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { SafetyMode } from "../config.js";
import { GodotMcpError } from "../errors.js";

export type ToolHints = Required<Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint">>;

export function enforceModePolicy(
  mode: SafetyMode,
  annotations: ToolHints,
  options: { confirmed: boolean; toolName: string },
): void {
  if (mode === "full") return;

  if (mode === "read_only") {
    if (options.toolName === "godot_script_run") {
      throw new GodotMcpError(
        "blocked_by_policy",
        "Editor-script execution is blocked in read_only mode.",
        "Switch to full mode and explicitly set allowDangerous true.",
      );
    }
    if (!annotations.readOnlyHint) {
      throw new GodotMcpError(
        "blocked_by_policy",
        `Tool '${options.toolName}' is blocked in read_only mode.`,
        "Switch GODOT_MCP_MODE to full (or confirm_destructive for confirmed writes) to use mutating tools.",
      );
    }
    return;
  }

  // confirm_destructive
  if (annotations.readOnlyHint) return;

  if (options.toolName === "godot_script_run") {
    throw new GodotMcpError(
      "blocked_by_policy",
      "Editor-script execution is blocked in confirm_destructive mode; switch to full mode.",
      "Switch to full mode and explicitly set allowDangerous true.",
    );
  }

  if (annotations.destructiveHint && !options.confirmed) {
    throw new GodotMcpError(
      "blocked_by_policy",
      `Tool '${options.toolName}' requires confirmed true in confirm_destructive mode.`,
      "Re-issue the call with confirmed: true after reviewing the operation.",
    );
  }
}

export function isMutating(annotations: ToolHints): boolean {
  return !annotations.readOnlyHint;
}

export function cacheTagsFor(toolName: string, annotations: ToolHints): string[] {
  if (annotations.openWorldHint || toolName === "godot_script_run" || toolName === "godot_headless_run") {
    return ["*"];
  }
  if (toolName.startsWith("godot_node_") || toolName.startsWith("godot_scene_") || toolName === "godot_scene_instance") {
    return ["scene"];
  }
  if (toolName.startsWith("godot_signal_")) return ["signals", "scene"];
  if (toolName.startsWith("godot_resource_")) return ["resources"];
  if (toolName.startsWith("godot_project_setting_")) return ["project-settings"];
  if (toolName.startsWith("godot_fs_") || toolName.startsWith("godot_uid_") || toolName === "godot_export_project" || toolName === "godot_asset_generate") {
    return ["files"];
  }
  if (toolName.startsWith("godot_run_") || toolName.startsWith("godot_runtime_") || toolName.startsWith("godot_debug_")) {
    return ["runtime"];
  }
  return [`tool:${toolName}`];
}
