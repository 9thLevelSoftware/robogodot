import { cp, rm } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBounded } from "./process-runner.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const godot = process.env.GODOT_PATH;
if (!godot) throw new Error("GODOT_PATH is required");
const fixtureAddon = resolve(root, "tests/fixtures/godot_project/addons/godot_control_mcp");

function run(args, env = process.env, expectedOutput, forbiddenOutput) {
  return runBounded(godot, args, { cwd: root, env, expectedOutput, forbiddenOutput });
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a localhost port");
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

try {
  await run(["--headless", "--path", root, "--script", "tests/godot/phase_1_smoke.gd"], process.env, "PASS server shutdown");
  await run(["--headless", "--path", root, "--script", "tests/godot/phase_2_auth_smoke.gd"], process.env, "PASS authenticated single-client transport");
  await run(["--headless", "--path", root, "--script", "tests/godot/variant_parity_smoke.gd"], process.env, "PASS variant parity");
  await run(["--headless", "--path", root, "--script", "tests/godot/exec_smoke.gd"], process.env, "PASS guarded execution");
  await run(["--headless", "--path", root, "--script", "tests/godot/introspection_smoke.gd"], process.env, "PASS live ClassDB introspection");
  await rm(resolve(root, "tests/fixtures/godot_project/addons"), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await rm(resolve(root, "tests/fixtures/godot_project/.godot"), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await cp(resolve(root, "addons/godot_control_mcp"), fixtureAddon, { recursive: true });
  await run(["--headless", "--editor", "--path", resolve(root, "tests/fixtures/godot_project"), "--script", resolve(root, "tests/godot/phase_5_bootstrap_smoke.gd")], { ...process.env, GODOT_MCP_TOKEN: "0123456789abcdef0123456789abcdef" }, "PASS phase 5 authenticated bridge bootstrap", /(?:SCRIPT ERROR|Compile Error)/);
  await run(["--headless", "--editor", "--path", resolve(root, "tests/fixtures/godot_project"), "--script", resolve(root, "tests/godot/phase_3_edit_controller_smoke.gd")], { ...process.env, GODOT_MCP_TOKEN: "0123456789abcdef0123456789abcdef" }, "PASS phase 3 edit controller foundation");
  await run(["--headless", "--editor", "--path", resolve(root, "tests/fixtures/godot_project"), "--script", resolve(root, "tests/godot/phase_3_node_smoke.gd")], { ...process.env, GODOT_MCP_TOKEN: "0123456789abcdef0123456789abcdef" }, "PASS phase 3 undoable node tools");
  await run(["--headless", "--editor", "--path", resolve(root, "tests/fixtures/godot_project"), "--script", resolve(root, "tests/godot/phase_3_scene_smoke.gd")], { ...process.env, GODOT_MCP_TOKEN: "0123456789abcdef0123456789abcdef" }, "PASS phase 3 scene lifecycle");
  await run(["--headless", "--editor", "--path", resolve(root, "tests/fixtures/godot_project"), "--script", resolve(root, "tests/godot/phase_3_signal_instance_smoke.gd")], { ...process.env, GODOT_MCP_TOKEN: "0123456789abcdef0123456789abcdef" }, "PASS phase 3 signal instance");
  await run(["--headless", "--editor", "--path", resolve(root, "tests/fixtures/godot_project"), "--script", resolve(root, "tests/godot/phase_3_resource_project_smoke.gd")], { ...process.env, GODOT_MCP_TOKEN: "0123456789abcdef0123456789abcdef" }, "PASS phase 3 resource project");
  const lifecyclePort = process.env.GODOT_MCP_SMOKE_PORT ?? String(await freePort());
  if (!/^\d+$/.test(lifecyclePort) || Number(lifecyclePort) < 1 || Number(lifecyclePort) > 65535) throw new Error("GODOT_MCP_SMOKE_PORT must be an integer from 1 to 65535");
  const missingTokenEnv = { ...process.env, GODOT_MCP_PORT: lifecyclePort };
  delete missingTokenEnv.GODOT_MCP_TOKEN;
  const compileDiagnostics = /(?:SCRIPT ERROR|Compile Error)/;
  await run(["--headless", "--editor", "--path", resolve(root, "tests/fixtures/godot_project"), "--script", resolve(root, "tests/godot/editor_plugin_missing_token_smoke.gd")], missingTokenEnv, "PASS missing token disables listener and leaves plugin enabled", compileDiagnostics);
  await run(["--headless", "--editor", "--path", resolve(root, "tests/fixtures/godot_project"), "--script", resolve(root, "tests/godot/editor_plugin_lifecycle_smoke.gd")], { ...process.env, GODOT_MCP_PORT: lifecyclePort, GODOT_MCP_TOKEN: "0123456789abcdef0123456789abcdef" }, "PASS editor plugin enter/exit/re-enable", compileDiagnostics);
} finally {
  await rm(resolve(root, "tests/fixtures/godot_project/addons"), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await rm(resolve(root, "tests/fixtures/godot_project/.godot"), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
