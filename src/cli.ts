#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  createModels,
  type AuthEvent,
  type AuthInteraction,
  type AuthPrompt,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { FileCredentialStore } from "./credential-store.js";
import { createGateway } from "./gateway.js";
import { createPiCodexRuntime, PiCodexUpstream } from "./pi-codex-upstream.js";
import { ServiceControl } from "./service-control.js";
import { resolveGatewayPaths } from "./xdg-paths.js";

const PROVIDER_ID = "openai-codex";

interface CliOptions {
  command: "serve" | "stop" | "login" | "logout" | "status" | "models" | "help";
  host: string;
  port: number;
  authFile: string;
}

async function main(): Promise<void> {
  const paths = resolveGatewayPaths();
  const options = parseArgs(process.argv.slice(2), paths.authFile);
  if (options.command === "help") {
    printHelp();
    return;
  }

  if (paths.usesRuntimeFallback) {
    console.warn("XDG_RUNTIME_DIR is not set; using a private temporary runtime directory.");
  }

  const service = new ServiceControl(paths.pidFile);
  if (options.command === "stop") {
    const stopped = await service.stop();
    console.log(stopped ? "AI Gateway stop signal sent." : "AI Gateway is not running.");
    return;
  }

  const credentials = new FileCredentialStore(options.authFile);
  if (options.command === "status") {
    const entry = (await credentials.list()).find((item) => item.providerId === PROVIDER_ID);
    console.log(entry ? "Logged in with ChatGPT Codex OAuth." : "Not logged in.");
    return;
  }
  if (options.command === "logout") {
    await credentials.delete(PROVIDER_ID);
    console.log("Removed the ChatGPT Codex OAuth credential.");
    return;
  }
  if (options.command === "login") {
    await login(credentials);
    return;
  }

  const runtime = createPiCodexRuntime(credentials);
  if (options.command === "models") {
    for (const model of runtime.models) console.log(model.id);
    return;
  }

  const gateway = createGateway({
    models: runtime.models.map((model) => ({ id: model.id })),
    upstream: new PiCodexUpstream(runtime),
  });
  await service.register();
  try {
    await gateway.listen({ host: options.host, port: options.port });
  } catch (error) {
    await service.unregister();
    throw error;
  }
  console.log(`AI Gateway is listening on http://${formatHost(options.host)}:${options.port}/v1`);

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await gateway.close();
    } finally {
      await service.unregister();
    }
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

async function login(credentials: FileCredentialStore): Promise<void> {
  const models = createModels({ credentials });
  models.setProvider(openaiCodexProvider());
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Login cancelled."));
  process.once("SIGINT", abort);
  const interaction: AuthInteraction = {
    signal: controller.signal,
    notify(event) {
      showAuthEvent(event);
    },
    async prompt(prompt) {
      return ask(readline, prompt);
    },
  };
  try {
    await models.login(PROVIDER_ID, "oauth", interaction);
    console.log("Login complete. The credential is in the gateway auth store.");
  } finally {
    process.off("SIGINT", abort);
    readline.close();
  }
}

async function ask(
  readline: ReturnType<typeof createInterface>,
  prompt: AuthPrompt,
): Promise<string> {
  if (prompt.type === "select") {
    console.log(prompt.message);
    prompt.options.forEach((option, index) => {
      console.log(`  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`);
    });
    const answer = await readline.question("Select an option: ", { signal: prompt.signal });
    const index = Number.parseInt(answer, 10) - 1;
    return prompt.options[index]?.id ?? answer.trim();
  }
  const answer = await readline.question(`${prompt.message} `, { signal: prompt.signal });
  return answer.trim();
}

function showAuthEvent(event: AuthEvent): void {
  if (event.type === "auth_url") {
    console.log(event.instructions ?? "Open this URL to sign in:");
    console.log(event.url);
    openBrowser(event.url);
  } else if (event.type === "device_code") {
    console.log(`Open ${event.verificationUri} and enter code ${event.userCode}.`);
  } else if (event.type === "progress") {
    console.log(event.message);
  } else {
    console.log(event.message);
    for (const link of event.links ?? []) console.log(`${link.label ? `${link.label}: ` : ""}${link.url}`);
  }
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? { file: "open", args: [url] }
      : process.platform === "win32"
        ? { file: "cmd", args: ["/c", "start", "", url] }
        : { file: "xdg-open", args: [url] };
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => undefined);
  child.unref();
}

function parseArgs(args: string[], defaultAuthFile: string): CliOptions {
  let command: CliOptions["command"] = args.length === 0 ? "help" : "serve";
  let host = "127.0.0.1";
  let port = 8787;
  let authFile = defaultAuthFile;
  let index = 0;
  if (args[0] && !args[0].startsWith("-")) {
    const value = args[0];
    if (!["serve", "stop", "login", "logout", "status", "models", "help"].includes(value)) {
      throw new Error(`Unknown command '${value}'.`);
    }
    command = value as CliOptions["command"];
    index = 1;
  }
  for (; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") command = "help";
    else if (argument === "--host") host = requiredArgument(args, ++index, "--host");
    else if (argument === "--port") {
      port = Number.parseInt(requiredArgument(args, ++index, "--port"), 10);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Port must be from 0 to 65535.");
    } else if (argument === "--auth-file") authFile = requiredArgument(args, ++index, "--auth-file");
    else throw new Error(`Unknown option '${argument}'.`);
  }
  return { command, host, port, authFile };
}

function requiredArgument(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new Error(`${option} needs a value.`);
  return value;
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function printHelp(): void {
  console.log(`AI Gateway

Usage:
  ai-gateway login [--auth-file PATH]
  ai-gateway serve [--host HOST] [--port PORT] [--auth-file PATH]
  ai-gateway stop
  ai-gateway status [--auth-file PATH]
  ai-gateway models
  ai-gateway logout [--auth-file PATH]

The serve command binds to 127.0.0.1:8787 by default.
Credentials use $XDG_STATE_HOME/ai-gateway/auth.json by default.
Runtime files use $XDG_RUNTIME_DIR/ai-gateway by default.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "AI Gateway failed.");
  process.exitCode = 1;
});
