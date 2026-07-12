import { spawn } from "node:child_process";
import process from "node:process";

function waitForCleanup(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve();
    };
    const deadline = setTimeout(() => {
      child.kill?.("SIGKILL");
      finish();
    }, timeoutMs);
    child.once("error", finish);
    child.once("exit", finish);
  });
}

export function runBounded(executable, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const spawnImpl = options.spawnImpl ?? spawn;
  const killImpl = options.killImpl ?? process.kill;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5_000;
  return new Promise((resolve, reject) => {
    const expectedOutput = options.expectedOutput;
    const forbiddenOutput = options.forbiddenOutput;
    let output = "";
    const child = spawnImpl(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: expectedOutput ? ["ignore", "pipe", "pipe"] : (options.stdio ?? "inherit"),
      windowsHide: true,
      detached: platform !== "win32",
    });
    if (expectedOutput) {
      child.stdout?.on("data", (chunk) => { const text = String(chunk); output += text; process.stdout.write(text); });
      child.stderr?.on("data", (chunk) => { const text = String(chunk); output += text; process.stderr.write(text); });
    }
    let finished = false;
    let timingOut = false;
    const finish = (callback) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(async () => {
      timingOut = true;
      const error = new Error(`Godot timed out after ${timeoutMs} ms: ${args.join(" ")}`);
      try {
        if (platform === "win32") {
          const killer = spawnImpl("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
          await waitForCleanup(killer, cleanupTimeoutMs);
        } else if (child.pid !== undefined) {
          try { killImpl(-child.pid, "SIGKILL"); } catch (killError) {
            if (killError?.code !== "ESRCH") throw killError;
          }
        }
      } catch {
        // Cleanup diagnostics must never replace the original timeout.
      } finally {
        finish(() => reject(error));
      }
    }, timeoutMs);
    child.once("error", (error) => {
      if (!timingOut) finish(() => reject(error));
    });
    child.once("exit", (code) => {
      if (!timingOut) finish(() => code !== 0 ? reject(new Error(`Godot exited with code ${code}`)) : expectedOutput && !output.includes(expectedOutput) ? reject(new Error(`Godot exited without required output marker: ${expectedOutput}`)) : forbiddenOutput && forbiddenOutput.test(output) ? reject(new Error(`Godot emitted forbidden output matching ${forbiddenOutput}`)) : resolve());
    });
  });
}
