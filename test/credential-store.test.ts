import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileCredentialStore } from "../src/credential-store.js";

test("stores OAuth credentials in a restricted file without exposing them in listings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-gateway-"));
  const path = join(directory, "auth.json");
  const store = new FileCredentialStore(path);
  const credential = {
    type: "oauth" as const,
    access: "access-secret",
    refresh: "refresh-secret",
    expires: 123,
    accountId: "account-1",
  };

  await store.modify("openai-codex", async () => credential);

  assert.deepEqual(await store.read("openai-codex"), credential);
  assert.deepEqual(await store.list(), [
    { providerId: "openai-codex", type: "oauth" },
  ]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o077, 0);
  assert.match(await readFile(path, "utf8"), /refresh-secret/);

  await store.delete("openai-codex");
  assert.equal(await store.read("openai-codex"), undefined);
});

test("rejects a credential directory accessible by other users", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-gateway-"));
  await chmod(directory, 0o755);
  const store = new FileCredentialStore(join(directory, "auth.json"));

  await assert.rejects(
    store.modify("openai-codex", async () => ({ type: "api_key", key: "secret" })),
    /must not be accessible by other users/,
  );
});

test("rejects a symbolic link credential file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-gateway-"));
  const target = join(directory, "target.json");
  const path = join(directory, "auth.json");
  await writeFile(target, "{}\n", { mode: 0o600 });
  await symlink(target, path);

  await assert.rejects(new FileCredentialStore(path).list());
});

test("rejects a credential file accessible by other users", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-gateway-"));
  const path = join(directory, "auth.json");
  await writeFile(path, "{}\n", { mode: 0o644 });
  await chmod(path, 0o644);

  await assert.rejects(
    new FileCredentialStore(path).list(),
    /must not be accessible by other users/,
  );
});

test("serializes concurrent credential refreshes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-gateway-"));
  const store = new FileCredentialStore(join(directory, "auth.json"));
  await store.modify("openai-codex", async () => ({ type: "api_key", key: "0" }));

  await Promise.all(
    Array.from({ length: 5 }, () =>
      store.modify("openai-codex", async (current) => ({
        type: "api_key",
        key: String(Number(current?.type === "api_key" ? current.key : 0) + 1),
      })),
    ),
  );

  assert.deepEqual(await store.read("openai-codex"), { type: "api_key", key: "5" });
});
