import { constants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Private directory '${path}' must be a directory and not a symbolic link.`);
  }
  assertOwnedByCurrentUser(path, info.uid);
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`Private directory '${path}' must not be accessible by other users.`);
  }
}

export async function openPrivateFile(path: string): Promise<FileHandle> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Private file '${path}' must be a regular file.`);
    assertOwnedByCurrentUser(path, info.uid);
    if ((info.mode & 0o077) !== 0) {
      throw new Error(`Private file '${path}' must not be accessible by other users.`);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function assertOwnedByCurrentUser(path: string, owner: number): void {
  if (typeof process.getuid === "function" && owner !== process.getuid()) {
    throw new Error(`Private path '${path}' must be owned by the current user.`);
  }
}
