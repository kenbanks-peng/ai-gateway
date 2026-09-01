import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { resolveGatewayPaths } from "../src/xdg-paths.js";

test("uses XDG state and runtime directories", () => {
  const paths = resolveGatewayPaths({
    XDG_STATE_HOME: "/state",
    XDG_RUNTIME_DIR: "/runtime",
  });

  assert.deepEqual(paths, {
    authFile: join("/state", "ai-gateway", "auth.json"),
    pidFile: join("/runtime", "ai-gateway", "gateway.pid"),
    usesRuntimeFallback: false,
  });
});

test("uses the XDG state default when XDG_STATE_HOME is empty", () => {
  const paths = resolveGatewayPaths(
    { XDG_STATE_HOME: "", XDG_RUNTIME_DIR: "/runtime" },
    "/home/tester",
  );

  assert.equal(paths.authFile, join("/home/tester", ".local", "state", "ai-gateway", "auth.json"));
});

test("uses a private per-user runtime fallback when XDG_RUNTIME_DIR is empty", () => {
  const paths = resolveGatewayPaths(
    { XDG_STATE_HOME: "/state", XDG_RUNTIME_DIR: "" },
    "/home/tester",
    "/temporary",
  );

  assert.match(paths.pidFile, /^\/temporary\/ai-gateway-runtime-\d+\/gateway\.pid$/);
  assert.equal(paths.usesRuntimeFallback, true);
});

test("rejects relative XDG directories", () => {
  assert.throws(
    () => resolveGatewayPaths({ XDG_STATE_HOME: "relative", XDG_RUNTIME_DIR: "/runtime" }),
    /XDG_STATE_HOME must contain an absolute path/,
  );
  assert.throws(
    () => resolveGatewayPaths({ XDG_STATE_HOME: "/state", XDG_RUNTIME_DIR: "relative" }),
    /XDG_RUNTIME_DIR must contain an absolute path/,
  );
});

test("explicit file overrides take precedence over XDG directories", () => {
  const paths = resolveGatewayPaths({
    AI_GATEWAY_AUTH_FILE: "custom/auth.json",
    AI_GATEWAY_PID_FILE: "custom/gateway.pid",
    XDG_STATE_HOME: "relative",
    XDG_RUNTIME_DIR: "relative",
  });

  assert.equal(paths.authFile, "custom/auth.json");
  assert.equal(paths.pidFile, "custom/gateway.pid");
  assert.equal(paths.usesRuntimeFallback, false);
});
