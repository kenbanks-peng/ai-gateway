import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: string[], environment: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForExit(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Process ${pid} did not exit.`);
}

test("start creates a background service that stop terminates", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-gateway-cli-"));
  const pidFile = join(directory, "gateway.pid");
  const environment = {
    ...process.env,
    AI_GATEWAY_AUTH_FILE: join(directory, "auth.json"),
    AI_GATEWAY_PID_FILE: pidFile,
  };
  let servicePid: number | undefined;

  try {
    const started = await runCli(["start", "--port", "0"], environment);
    assert.equal(started.code, 0, started.stderr);

    servicePid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
    const logFile = join(directory, `${servicePid}-gateway.log`);
    assert.equal(
      started.stdout,
      `PID ${servicePid}. Logs:\n $XDG_STATE_HOME/ai-gateway/${servicePid}-gateway.log\n`,
    );
    await readFile(logFile, "utf8");
    assert.notEqual(servicePid, process.pid);
    process.kill(servicePid, 0);

    const stopped = await runCli(["stop"], environment);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(stopped.stdout, "AI Gateway stopped.\n");
    await waitForExit(servicePid);
  } finally {
    if (servicePid !== undefined) {
      try { process.kill(servicePid, "SIGKILL"); } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
});
