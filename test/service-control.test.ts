import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ServiceControl } from "../src/service-control.js";

test("registers the serving process and stops it with SIGTERM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-gateway-service-"));
  const pidFile = join(directory, "runtime", "gateway.pid");
  const signals: Array<NodeJS.Signals | 0> = [];
  const processes = {
    pid: 12345,
    kill(pid: number, signal: NodeJS.Signals | 0) {
      assert.equal(pid, 12345);
      signals.push(signal);
      return true;
    },
  };
  const service = new ServiceControl(pidFile, join(directory, "gateway.log"), processes);

  await service.register();

  assert.equal(await readFile(pidFile, "utf8"), "12345\n");
  assert.equal((await stat(pidFile)).mode & 0o777, 0o600);
  assert.equal(await service.stop(), true);
  assert.deepEqual(signals, [0, "SIGTERM"]);

  await service.unregister();
  await assert.rejects(readFile(pidFile, "utf8"), { code: "ENOENT" });
});

test("reports no service for a stale PID file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-gateway-service-"));
  const pidFile = join(directory, "gateway.pid");
  await writeFile(pidFile, "67890\n", { mode: 0o600 });
  const processes = {
    pid: 12345,
    kill() {
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    },
  };
  const service = new ServiceControl(pidFile, join(directory, "gateway.log"), processes);

  assert.equal(await service.stop(), false);
  await assert.rejects(readFile(pidFile, "utf8"), { code: "ENOENT" });
});
