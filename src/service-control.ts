import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { ensurePrivateDirectory, openPrivateFile } from "./private-files.js";

interface ProcessControl {
  readonly pid: number;
  kill(pid: number, signal: NodeJS.Signals | 0): boolean;
}

export interface ServiceCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

export class ServiceControl {
  constructor(
    readonly pidFile: string,
    readonly logFile: string,
    private readonly processControl: ProcessControl = process,
  ) {}

  async start(command: ServiceCommand): Promise<number> {
    await this.removeStalePid();
    await ensurePrivateDirectory(dirname(this.pidFile));
    await ensurePrivateDirectory(dirname(this.logFile));

    const log = await open(
      this.logFile,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    let child: ChildProcess | undefined;
    let childPid: number | undefined;
    try {
      child = spawn(command.executable, [...command.args], {
        detached: true,
        env: command.environment,
        stdio: ["ignore", log.fd, log.fd, "pipe"],
      });
      await waitForSpawn(child);
      childPid = child.pid;
      if (childPid === undefined) throw new Error("The service process did not have a PID.");

      await this.register(childPid);
      child.unref();
      await waitForReady(child);
      return childPid;
    } catch (error) {
      if (childPid !== undefined) {
        try { this.processControl.kill(childPid, "SIGTERM"); } catch {}
        await this.unregister(childPid);
      }
      const reason = error instanceof Error ? error.message : "unknown startup error";
      throw new Error(`AI Gateway did not start: ${reason} See ${this.logFile}.`);
    } finally {
      await log.close();
    }
  }

  async register(pid: number = this.processControl.pid): Promise<void> {
    await ensurePrivateDirectory(dirname(this.pidFile));

    const existingPid = await this.readPid();
    if (existingPid !== undefined && this.isRunning(existingPid)) {
      if (existingPid === pid) return;
      throw new Error(`AI Gateway is already running with PID ${existingPid}.`);
    }
    await rm(this.pidFile, { force: true });

    const file = await open(this.pidFile, "wx", 0o600);
    try {
      await file.writeFile(`${pid}\n`, "utf8");
    } finally {
      await file.close();
    }
  }

  async unregister(pid: number = this.processControl.pid): Promise<void> {
    if ((await this.readPid()) === pid) {
      await rm(this.pidFile, { force: true });
    }
  }

  async stop(): Promise<boolean> {
    const pid = await this.readPid();
    if (pid === undefined || !this.isRunning(pid)) {
      await rm(this.pidFile, { force: true });
      return false;
    }

    this.processControl.kill(pid, "SIGTERM");
    return true;
  }

  private async removeStalePid(): Promise<void> {
    const pid = await this.readPid();
    if (pid !== undefined && this.isRunning(pid)) {
      throw new Error(`AI Gateway is already running with PID ${pid}.`);
    }
    await rm(this.pidFile, { force: true });
  }

  private async readPid(): Promise<number | undefined> {
    try {
      const handle = await openPrivateFile(this.pidFile);
      let value: string;
      try {
        value = (await handle.readFile("utf8")).trim();
      } finally {
        await handle.close();
      }
      const pid = Number(value);
      return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private isRunning(pid: number): boolean {
    try {
      this.processControl.kill(pid, 0);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ESRCH") return false;
      throw error;
    }
  }
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function waitForReady(child: ChildProcess): Promise<void> {
  const readyStream = child.stdio[3];
  if (!(readyStream instanceof Readable)) {
    return Promise.reject(new Error("The readiness channel is unavailable."));
  }

  return new Promise((resolve, reject) => {
    let response = "";
    const timer = setTimeout(() => finish(new Error("Service startup timed out.")), 10_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      readyStream.removeAllListeners();
      if (error) reject(error);
      else resolve();
    };
    const onExit = (code: number | null) => finish(new Error(`Service process exited with code ${code ?? "unknown"}.`));

    readyStream.setEncoding("utf8");
    readyStream.on("data", (chunk: string) => {
      response += chunk;
      if (response.includes("ready\n")) finish();
    });
    readyStream.once("end", () => finish(new Error("Service process closed before it was ready.")));
    readyStream.once("error", (error) => finish(error));
    child.once("exit", onExit);
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
