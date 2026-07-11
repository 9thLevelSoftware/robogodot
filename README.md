# Godot Control MCP — Phase 1

Phase 1 provides a localhost-only Godot 4.6.x editor plugin and a Node 22 MCP server with three read-only probes: `godot_connection_status`, `godot_get_version`, and `godot_ping`.

## Quickstart

Requirements: Node.js 22, npm, and Godot 4.6.x. Install and build:

```sh
cd server
npm ci && npm run build
```

Copy `addons/godot_control_mcp` into your Godot project's `addons` directory. In Godot, open **Project > Project Settings > Plugins** and enable **Godot Control MCP**. Keep that editor open.

Configure an MCP client (replace both absolute paths):

```json
{
  "mcpServers": {
    "godot-control": {
      "command": "node",
      "args": ["C:/absolute/path/to/RoboGodot/server/dist/index.js"],
      "env": { "GODOT_PROJECT_PATH": "C:/absolute/path/to/project" }
    }
  }
}
```

Environment variables:

- `GODOT_PATH`: Godot executable; for example `C:\Users\you\Downloads\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64\Godot_v4.6.2-stable_mono_win64_console.exe`.
- `GODOT_PROJECT_PATH`: project directory (otherwise discovered upward from the server working directory).
- `GODOT_MCP_PORT`: editor WebSocket port, default `9200`; set identically for the plugin and server.
- `GODOT_LSP_PORT`: reserved LSP port, default `6005`.
- `GODOT_DAP_PORT`: reserved DAP port, default `6006`.
- `GODOT_MCP_MODE`: `full`, `read_only`, or `confirm_destructive`; Phase 1 probes are read-only.
- `DEBUG`: `true` or `1` for debug logs.

Call `godot_connection_status` first, then `godot_get_version` and `godot_ping`.

## Verification

```sh
node --test tests/architecture/*.test.mjs
cd server
npm test -- --run
npm run typecheck
npm run build
```

Plugin smoke and the real restart/reconnect acceptance test are opt-in:

```powershell
$env:GODOT_PATH='C:\path\to\Godot_v4.6.2-stable_console.exe'
node tests/godot/run-smoke.mjs
cd server
npm run test:live
```

Without `GODOT_PATH`, the live suite is explicitly skipped.

## Troubleshooting and scope

If status is not connected, confirm the correct project is open, the plugin is enabled, and `GODOT_MCP_PORT` matches and is unused. Only `127.0.0.1` is accepted. Application logs go to **stderr** because MCP protocol messages own **stdout**; redirecting logs to stdout will break the client connection.

Phase 1 intentionally excludes scene/resource mutation, filesystem tools, import/export, LSP and DAP operations, runtime launch/control, screenshots, input injection, policy enforcement, approvals, audit persistence, and remote/network access.
