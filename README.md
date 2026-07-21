# Godot Control MCP — Phase 4

Godot Control MCP connects an MCP host to one local Godot 4.6.x editor. Phase 4 exposes exactly 38 public tools: Phase 3's 31 public tools plus seven read-only Godot LSP tools. There are no aliases.

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
- `GODOT_LSP_PORT`: Godot language-server TCP port, default `6005`.
- `GODOT_MCP_LSP_AUTO_START`: `false` by default; only `true` or `1` lets the server start a headless editor when no visible editor LSP is listening.
- `GODOT_DAP_PORT`: reserved debug-adapter port, default `6006`.
- `GODOT_MCP_MODE`: `full` (default), `read_only`, or `confirm_destructive`. **Until Phase 7 hardening, mode only gates `godot_script_run`** (blocked outside `full`, and `full` still requires `allowDangerous: true`). Curated editor mutations, scene lifecycle/persistence, and LSP tools do not yet consult this mode.
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
| `godot_lsp_diagnostics` | Synchronize one script and return fresh pushed diagnostics |
| `godot_lsp_completion` | Return bounded completion items at a script position |
| `godot_lsp_hover` | Return bounded hover text at a script position |
| `godot_lsp_signature_help` | Return bounded signature and parameter help |
| `godot_lsp_document_symbols` | Return a bounded hierarchy for one script |
| `godot_lsp_workspace_symbols` | Query advertised workspace symbols without inventing an index |
| `godot_lsp_native_symbol` | Return bounded native Godot class or member documentation |

All curated in-memory mutations enter a single FIFO mutation lane before reaching Godot, preventing concurrent requests from capturing stale inverse state. Each accepted node, signal, instance, or project-setting mutation creates one `EditorUndoRedoManager` action; users undo it with normal Godot Ctrl-Z. Scene open/new are lifecycle operations, while scene/resource save are explicit persistence operations: none claims UndoRedo semantics.

Curated paths must be canonical `res://` paths without backslashes, empty segments, `.` or `..`, and are bounded to 1024 UTF-8 bytes. Node paths are bounded to 1024 UTF-8 bytes; names and types to 255, and properties/methods to 256. Tree, signal, and setting reads have explicit pagination, depth/count, scan, and response-envelope bounds. `godot_node_call_method` supports only the zero-argument read-only allowlist `get_path`, `get_child_count`, and `is_inside_tree`.

Resource handles are opaque, resource-only, authenticated-session-scoped values. Disconnecting the authenticated client, restarting the plugin, or restarting the editor invalidates every old handle. The Phase 3 live acceptance covers same-editor disconnect and re-authentication; the general live transport test separately covers editor-process restart. Save refuses an existing target unless overwrite is explicitly confirmed. That check intentionally has a narrow overwrite TOCTOU window; Phase 6/7 realpath containment and atomic no-replace hardening are deferred and are not claimed here.

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

## Godot LSP runbook

The seven `godot_lsp_*` tools all declare `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: false`. They never write source files or apply edits. Inputs are strict objects: undeclared fields are rejected. A `position` is `{ line, character }`; both are required integers from 0 through 1,000,000. A `range` is `{ start: position, end: position }`. These are the exact public inputs and normalized structured outputs (remote fields not listed are omitted):

| Tool | Inputs | Output |
| --- | --- | --- |
| `godot_lsp_diagnostics` | required `uri`; optional `waitMs` integer 100–15000, default 5000 | `{ uri, version, fresh, diagnostics, truncated, truncation }`. Each diagnostic requires `message` and may include `range`, `severity`, string/number `code`, `source`, `tags`, and `relatedInformation`; each related item is `{ location: { uri, range }, message }`. `truncation` always has booleans `diagnostics`, `tags`, `relatedInformation`, `strings`, `positions`, and `malformed`. |
| `godot_lsp_completion` | required `uri` and `position`; optional `limit` integer 1–500, default 500; optional strict `context` with required `triggerKind` integer 1–3 and optional `triggerCharacter` | `{ items, truncated }`. Each retained item requires `label` and may include `detail`, integer `kind`, `documentation`, `insertText`, `sortText`, `filterText`, and `textEdit: { range, newText }`. |
| `godot_lsp_hover` | required `uri` and `position` | Not found: `{ found: false, truncated }`. Found: `{ found: true, contents, truncated }` plus optional `range`. |
| `godot_lsp_signature_help` | required `uri` and `position` | `{ signatures, truncated, truncation }` plus optional integer `activeSignature` and `activeParameter`. Each signature is `{ label, parameters }` plus optional `documentation`; each parameter has `label` as a string or `[start, end]` integer pair and optional `documentation`. `truncation` always has booleans `signatures`, `parameters`, `malformed`, and `strings`. |
| `godot_lsp_document_symbols` | required `uri` | `{ symbols, truncated }`. Each symbol requires `name` and may include `detail`, integer `kind`, `range`, `selectionRange`, `location: { uri, range }`, and recursive `children`. |
| `godot_lsp_workspace_symbols` | required `query`; optional `limit` integer 1–500, default 500 | `{ symbols, truncated }` with the same normalized symbol fields. A malformed successful `null` or non-array reply normalizes to empty `symbols` with `truncated: true`. Before a result, unavailable service returns structured `not_connected`; unadvertised `workspaceSymbols` returns `feature_disabled`; `godot_error` is reserved for LSP request or protocol failure. |
| `godot_lsp_native_symbol` | required `nativeClass`; optional `member` | No match: `{ found: false }`. Match: `{ found: true, symbol, truncated }`, where `symbol` is the bounded Godot response tree. It can also return structured `not_connected`, `feature_disabled`, or `godot_error`. |

All `uri`, `query`, `nativeClass`, `member`, and `triggerCharacter` strings are bounded to 1024 UTF-8 bytes. Completion/document/workspace arrays and recursive trees are bounded; `truncated: true` means fields or entries were omitted or shortened. Completion, hover, symbol, and native-tree outputs expose the aggregate boolean only. Diagnostics and signature help additionally expose the category objects listed above so callers can distinguish array, nested-data, string, position, and malformed omissions.

`uri` accepts only a project-relative `res://` path to an existing `.gd` file inside the configured project. The server reads the exact disk bytes, rejects escapes after canonical realpath checks, and synchronizes that exact text with `didOpen`/`didChange`; unsaved editor-buffer text is not copied into MCP. Positions are zero-based UTF-16 code-unit offsets, not UTF-8 byte or Unicode-code-point offsets.

Normally, open the project in the visible Godot editor; RoboGodot attaches to its LSP and never owns or shuts down that editor. For manual headless service, run exactly:

```sh
godot --editor --headless --lsp-port 6005 --path <project>
```

With `GODOT_MCP_LSP_AUTO_START=true`, RoboGodot first attaches if a compatible listener is already available. Otherwise it launches that same headless command using `GODOT_PATH`. Shutdown is owned-child-only: RoboGodot terminates only the child process it spawned, never an attached visible editor or independently launched headless editor.

Godot 4.6 does not register `workspace/symbol`; `godot_lsp_workspace_symbols` therefore returns `feature_disabled`. Use `godot_lsp_document_symbols` with a specific `res://` script instead. A `not_connected` result means no compatible LSP is listening: open the project in Godot, verify `GODOT_PROJECT_PATH` and `GODOT_LSP_PORT`, or opt into auto-start. Other `feature_disabled` results mean the connected server did not advertise that method; use a supported tool rather than expecting a fabricated result. For a diagnostics timeout or `fresh: false`, confirm the script exists on disk, fix Godot parse/import errors, keep the editor responsive, and retry after disk synchronization; do not treat stale diagnostics as current.

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
npm run test:live:phase4
```

If the bridge stays disconnected, verify the plugin is enabled and that `GODOT_MCP_TOKEN` and `GODOT_MCP_PORT` match in both processes. Errors are structured with an actionable hint.
