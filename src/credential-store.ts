import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ensurePrivateDirectory, openPrivateFile } from "./private-files.js";

const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

type AuthFile = Record<string, Credential>;

export class FileCredentialStore implements CredentialStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  async read(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    throwIfAborted(options?.signal);
    return (await this.readAll())[providerId];
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    throwIfAborted(options?.signal);
    const credentials = await this.readAll();
    return Object.entries(credentials)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      throwIfAborted(options?.signal);
      return this.withLock(async () => {
        const credentials = await this.readAll();
        const current = credentials[providerId];
        const next = await fn(current);
        throwIfAborted(options?.signal);
        if (next === undefined) return current;
        credentials[providerId] = next;
        await this.writeAll(credentials);
        return next;
      }, options?.signal);
    });
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.enqueue(async () => {
      throwIfAborted(options?.signal);
      await this.withLock(async () => {
        const credentials = await this.readAll();
        if (!(providerId in credentials)) return;
        delete credentials[providerId];
        await this.writeAll(credentials);
      }, options?.signal);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation, operation);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readAll(): Promise<AuthFile> {
    let text: string;
    try {
      const handle = await openPrivateFile(this.path);
      try {
        text = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return {};
      throw error;
    }
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Credential file '${this.path}' must contain a JSON object.`);
    }
    return value as AuthFile;
  }

  private async writeAll(credentials: AuthFile): Promise<void> {
    const directory = dirname(this.path);
    await ensurePrivateDirectory(directory);
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      try {
        await handle.writeFile(`${JSON.stringify(credentials, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private async withLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const lockPath = `${this.path}.lock`;
    await ensurePrivateDirectory(dirname(this.path));
    const started = Date.now();
    while (true) {
      throwIfAborted(signal);
      try {
        await mkdir(lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        try {
          const lockStat = await lstat(lockPath);
          if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
            throw new Error(`Credential lock '${lockPath}' must be a directory and not a symbolic link.`);
          }
          if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
            await rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if (!isNodeError(statError, "ENOENT")) throw statError;
          continue;
        }
        if (Date.now() - started > LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out while locking credential file '${this.path}'.`);
        }
        await delay(LOCK_WAIT_MS, signal);
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
