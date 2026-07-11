import { cp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const godot = process.env.GODOT_PATH;
if (!godot) throw new Error("GODOT_PATH is required");
const fixtureAddon = resolve(root, "tests/fixtures/godot_project/addons/godot_control_mcp");

function run(args, env = process.env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(godot, args, { cwd: root, env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`Godot exited with code ${code}`)));
  });
}

try {
  await run(["--headless", "--path", root, "--script", "tests/godot/phase_1_smoke.gd"]);
  await cp(resolve(root, "addons/godot_control_mcp"), fixtureAddon, { recursive: true });
  await run(["--headless", "--editor", "--path", resolve(root, "tests/fixtures/godot_project"), "--script", resolve(root, "tests/godot/editor_plugin_lifecycle_smoke.gd")], { ...process.env, GODOT_MCP_PORT: "19201" });
} finally {
  await rm(resolve(root, "tests/fixtures/godot_project/addons"), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await rm(resolve(root, "tests/fixtures/godot_project/.godot"), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
