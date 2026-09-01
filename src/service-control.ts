import { open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { ensurePrivateDirectory, openPrivateFile } from "./private-files.js";

interface ProcessControl {
  readonly pid: number;
  kill(pid: number, signal: NodeJS.Signals | 0): boolean;
}

export class ServiceControl {
  constructor(
    readonly pidFile: string,
    private readonly processControl: ProcessControl = process,
  ) {}

  async register(): Promise<void> {
    await ensurePrivateDirectory(dirname(this.pidFile));

    const existingPid = await this.readPid();
    if (existingPid !== undefined && this.isRunning(existingPid)) {
      throw new Error(`AI Gateway is already running with PID ${existingPid}.`);
    }
    await rm(this.pidFile, { force: true });

    const file = await open(this.pidFile, "wx", 0o600);
    try {
      await file.writeFile(`${this.processControl.pid}\n`, "utf8");
    } finally {
      await file.close();
    }
  }

  async unregister(): Promise<void> {
    if ((await this.readPid()) === this.processControl.pid) {
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
