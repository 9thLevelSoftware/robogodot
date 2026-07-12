# Godot Control MCP — Phase 3

Godot Control MCP connects an MCP host to one local Godot 4.6.x editor. Phase 3 exposes exactly 31 public tools: the existing eight probes, introspection, and guarded execution tools plus 23 curated editor tools. There are no aliases.

## Quickstart

Requirements: Node.js 22+, npm, Godot 4.6.x, and a random shared token containing 32–256 UTF-8 bytes.

```sh
cd server
npm ci && npm run build
```

Copy `addons/godot_control_mcp` into the target project's `addons` directory, enable **Godot Control MCP** under **Project > Project Settings > Plugins**, and keep that editor open. Give the plugin and server the same token:

```json
{
  "mcpServers": {
    "godot-control": {
      "command": "node",
      "args": ["C:/absolute/path/to/RoboGodot/server/dist/index.js"],
      "env": {
        "GODOT_PROJECT_PATH": "C:/absolute/path/to/project",
        "GODOT_MCP_TOKEN": "replace-with-at-least-32-random-bytes",
        "GODOT_MCP_MODE": "full"
      }
    }
  }
}
```

Set `GODOT_MCP_TOKEN` in the environment that launches Godot as well. The authenticated WebSocket control plane accepts exactly one client. Unauthenticated and second clients cannot dispatch commands.

Other environment variables:

- `GODOT_PATH`: Godot executable; for example `C:\Users\you\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe`.
- `GODOT_MCP_PORT`: localhost editor WebSocket port, default `9200`; set identically for plugin and server.
- `GODOT_LSP_PORT` / `GODOT_DAP_PORT`: reserved ports, defaults `6005` / `6006`.
- `GODOT_MCP_MODE`: `full` (default), `read_only`, or `confirm_destructive`.
- `DEBUG`: `true` or `1` for stderr debug logs. MCP owns stdout exclusively.

## Tools

| Tool | Purpose |
| --- | --- |
| `godot_connection_status` | Local editor-bridge state |
| `godot_get_version` | Engine, plugin, and project version |
| `godot_ping` | Authenticated editor round-trip |
| `godot_script_run` | Guarded transient `@tool` GDScript execution |
| `godot_api_list_classes` | Paginated live ClassDB class names |
| `godot_api_describe_class` | Paginated members declared on a live class |
| `godot_api_search` | Search live ClassDB class names |
| `godot_api_class_doc` | Official offline class/member documentation |
| `godot_node_add`, `godot_node_delete`, `godot_node_reparent`, `godot_node_rename`, `godot_node_duplicate` | Undoable scene-tree mutation |
| `godot_node_get`, `godot_node_set_property`, `godot_node_call_method` | Typed node inspection/property mutation and allowlisted read call |
| `godot_scene_instance` | Undoably instance a project scene |
| `godot_scene_open`, `godot_scene_new`, `godot_scene_save`, `godot_scene_tree`, `godot_scene_current` | Scene lifecycle, explicit persistence, and bounded reads |
| `godot_signal_list`, `godot_signal_connect`, `godot_signal_disconnect` | Bounded signal inspection and undoable connections |
| `godot_resource_load`, `godot_resource_create`, `godot_resource_save` | Session resource handles and explicit persistence |
| `godot_project_setting_get`, `godot_project_setting_set`, `godot_project_setting_list` | Exact project-setting reads and undoable persisted mutation |

All curated in-memory mutations enter a single FIFO mutation lane before reaching Godot, preventing concurrent requests from capturing stale inverse state. Each accepted node, signal, instance, or project-setting mutation creates one `EditorUndoRedoManager` action; users undo it with normal Godot Ctrl-Z. Scene open/new are lifecycle operations, while scene/resource save are explicit persistence operations: none claims UndoRedo semantics.

Curated paths must be canonical `res://` paths without backslashes, empty segments, `.` or `..`, and are bounded to 1024 UTF-8 bytes. Node paths are bounded to 1024 UTF-8 bytes; names and types to 255, and properties/methods to 256. Tree, signal, and setting reads have explicit pagination, depth/count, scan, and response-envelope bounds. `godot_node_call_method` supports only the zero-argument read-only allowlist `get_path`, `get_child_count`, and `is_inside_tree`.

Resource handles are opaque, resource-only, session-scoped values. Restarting the plugin invalidates every old handle. Save refuses an existing target unless overwrite is explicitly confirmed. That check intentionally has a narrow overwrite TOCTOU window; Phase 6/7 realpath containment and atomic no-replace hardening are deferred and are not claimed here.

Project-setting mutation snapshots both the prior value and prior absence, preflights exact restoration, then persists do and undo. If persistence or recovery cannot be proven, it fails closed; after an unproven recovery, further setting mutations stay blocked until plugin restart and inspection. The scene dirty-state fallback is also fail-closed: when Godot cannot authoritatively prove cleanliness, lifecycle replacement requires explicit `discardUnsaved`.

`godot_script_run` is the sole public execution name; there is no alias. Execution is blocked in `read_only` and `confirm_destructive`. In `full`, every call must include `allowDangerous: true`, independent of script text. Review source before allowing it: scripts run inside the editor and can mutate the project or access the host with the editor's permissions.

```json
{
  "source": "func __run(args):\n\tvar node := Node2D.new()\n\tnode.position = Vector2(args.x, args.y)\n\tvar result := node.position\n\tnode.free()\n\treturn result",
  "args": { "x": 12.5, "y": -3 },
  "allowDangerous": true
}
```

The TypeScript server owns a 15000 ms response deadline. A timeout does **not** cancel GDScript in-process. If the editor remains unresponsive, restart Godot, wait for authenticated reconnection, and retry only after correcting the script.

Introspection example:

```json
{ "class": "Node", "member": { "kind": "method", "name": "add_child" } }
```

Live metadata comes from the connected editor. Documentation is generated from the exact official Godot 4.6.2 commit `001aa128b1cd80dc4e47e823c360bccf45ed6bad`, bundled locally, provenance/integrity checked, and gated to a live Godot 4.6.x editor. Runtime documentation lookup performs no network access. See [documentation provenance](docs/third-party/godot-class-reference-4.6.2.md).

## Verification

```sh
node --test tests/architecture/*.test.mjs tests/godot/process-runner.test.mjs
cd server
npm test -- --run
npm run typecheck
npm run build
npm run docs:check
```

With `GODOT_PATH` set, run the real plugin/parser/execution/introspection smokes and authenticated authoring acceptance test:

```powershell
node tests/godot/run-smoke.mjs
cd server
npm run test:live
npm run test:live:phase3
```

If the bridge stays disconnected, verify the plugin is enabled and that `GODOT_MCP_TOKEN` and `GODOT_MCP_PORT` match in both processes. Errors are structured with an actionable hint.
