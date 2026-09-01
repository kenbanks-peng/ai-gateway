import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const APPLICATION_DIRECTORY = "ai-gateway";

export interface GatewayPaths {
  readonly authFile: string;
  readonly pidFile: string;
  readonly usesRuntimeFallback: boolean;
}

export function resolveGatewayPaths(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
  temporaryDirectory: string = tmpdir(),
): GatewayPaths {
  const authOverride = nonEmpty(environment.AI_GATEWAY_AUTH_FILE);
  const authFile = authOverride ?? join(
    xdgDirectory(environment.XDG_STATE_HOME, "XDG_STATE_HOME")
      ?? join(homeDirectory, ".local", "state"),
    APPLICATION_DIRECTORY,
    "auth.json",
  );

  const pidOverride = nonEmpty(environment.AI_GATEWAY_PID_FILE);
  if (pidOverride !== undefined) {
    return { authFile, pidFile: pidOverride, usesRuntimeFallback: false };
  }

  const runtimeHome = xdgDirectory(environment.XDG_RUNTIME_DIR, "XDG_RUNTIME_DIR");
  if (runtimeHome !== undefined) {
    return {
      authFile,
      pidFile: join(runtimeHome, APPLICATION_DIRECTORY, "gateway.pid"),
      usesRuntimeFallback: false,
    };
  }

  return {
    authFile,
    pidFile: join(temporaryDirectory, runtimeFallbackName(), "gateway.pid"),
    usesRuntimeFallback: true,
  };
}

function xdgDirectory(value: string | undefined, name: string): string | undefined {
  const directory = nonEmpty(value);
  if (directory === undefined) return undefined;
  if (!isAbsolute(directory)) throw new Error(`${name} must contain an absolute path.`);
  return directory;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function runtimeFallbackName(): string {
  if (typeof process.getuid !== "function") {
    throw new Error("XDG_RUNTIME_DIR must be set on platforms without numeric user IDs.");
  }
  return `ai-gateway-runtime-${process.getuid()}`;
}
