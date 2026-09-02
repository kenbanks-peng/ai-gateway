import { randomUUID } from "node:crypto";
import { type AddressInfo } from "node:net";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

export interface GatewayModel {
  id: string;
  provider?: string;
  created?: number;
}

export interface GatewayUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type GatewayEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | {
      type: "tool_call";
      index: number;
      id: string;
      name: string;
      argumentsDelta: string;
    }
  | {
      type: "done";
      finishReason: "stop" | "length" | "tool_calls";
      usage?: GatewayUsage;
    };

export interface ChatCompletionRequest {
  model: string;
  messages: unknown[];
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  reasoning_effort?: string;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream_options?: { include_usage?: boolean };
  [key: string]: unknown;
}

export interface UpstreamPort {
  generate(
    request: ChatCompletionRequest,
    options: { signal: AbortSignal; sessionId: string },
  ): AsyncIterable<GatewayEvent>;
}

export interface Gateway {
  listen(options: { host: string; port: number }): Promise<void>;
  close(): Promise<void>;
  address(): AddressInfo | string | null;
}

interface GatewayOptions {
  models: readonly GatewayModel[];
  upstream: UpstreamPort;
  debug?: boolean;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

export function createGateway(options: GatewayOptions): Gateway {
  const server = http.createServer((request, response) => {
    void route(request, response, options);
  });

  return {
    listen({ host, port }) {
      return new Promise((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(port, host, () => {
          server.off("error", onError);
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      });
    },
    address() {
      return server.address();
    },
  };
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: GatewayOptions,
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, { status: "ok" });
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return sendJson(response, 200, {
        object: "list",
        data: options.models.map((model) => ({
          id: model.id,
          object: "model",
          created: model.created ?? 0,
          owned_by: "openai-codex",
        })),
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = validateChatRequest(await readJson(request));
      const model = options.models.find((candidate) => candidate.id === body.model);
      if (!model) {
        return sendError(
          response,
          404,
          "invalid_request_error",
          `Model '${body.model}' does not exist.`,
          "model_not_found",
        );
      }
      return await completeChat(
        request,
        response,
        body,
        options.upstream,
        options.debug ? { provider: model.provider ?? "openai-codex", model: model.id } : undefined,
      );
    }
    sendError(response, 404, "invalid_request_error", "Route not found.", "not_found");
  } catch (error) {
    if (!response.headersSent) {
      const isRequestError = error instanceof RequestError;
      const message = safeErrorMessage(error);
      sendError(
        response,
        isRequestError ? 400 : 502,
        isRequestError ? "invalid_request_error" : "upstream_error",
        message,
        isRequestError ? "bad_request" : "upstream_error",
      );
    } else {
      response.end();
    }
  }
}

async function completeChat(
  incoming: IncomingMessage,
  response: ServerResponse,
  request: ChatCompletionRequest,
  upstream: UpstreamPort,
  debug?: { provider: string; model: string },
): Promise<void> {
  const controller = new AbortController();
  response.once("close", () => {
    if (!response.writableFinished) controller.abort();
  });
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const sessionId = getSessionId(incoming, id);
  if (debug) writeDebugRecord(sessionId, request, debug);
  const events = upstream.generate(request, { signal: controller.signal, sessionId });

  if (request.stream) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    writeSse(response, completionChunk(id, created, request.model, { role: "assistant" }, null));
    try {
      let sawDone = false;
      for await (const event of events) {
        if (event.type === "text") {
          writeSse(response, completionChunk(id, created, request.model, { content: event.delta }, null));
        } else if (event.type === "reasoning") {
          writeSse(
            response,
            completionChunk(id, created, request.model, { reasoning_content: event.delta }, null),
          );
        } else if (event.type === "tool_call") {
          writeSse(
            response,
            completionChunk(
              id,
              created,
              request.model,
              {
                tool_calls: [
                  {
                    index: event.index,
                    id: event.id,
                    type: "function",
                    function: { name: event.name, arguments: event.argumentsDelta },
                  },
                ],
              },
              null,
            ),
          );
        } else {
          sawDone = true;
          writeSse(response, completionChunk(id, created, request.model, {}, event.finishReason));
          if (request.stream_options?.include_usage && event.usage) {
            writeSse(response, {
              id,
              object: "chat.completion.chunk",
              created,
              model: request.model,
              choices: [],
              usage: openAIUsage(event.usage),
            });
          }
        }
      }
      if (!sawDone) throw new Error("Codex stream ended without a terminal event.");
      response.end("data: [DONE]\n\n");
    } catch (error) {
      if (!controller.signal.aborted) {
        writeSse(response, {
          error: {
            type: "upstream_error",
            code: "upstream_error",
            message: safeErrorMessage(error),
          },
        });
      }
      response.end();
    }
    return;
  }

  let content = "";
  let reasoning = "";
  let finishReason: "stop" | "length" | "tool_calls" = "stop";
  let usage: GatewayUsage | undefined;
  let sawDone = false;
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  for await (const event of events) {
    if (event.type === "text") content += event.delta;
    else if (event.type === "reasoning") reasoning += event.delta;
    else if (event.type === "tool_call") {
      const current = toolCalls.get(event.index) ?? {
        id: event.id,
        name: event.name,
        arguments: "",
      };
      current.arguments += event.argumentsDelta;
      toolCalls.set(event.index, current);
    } else {
      sawDone = true;
      finishReason = event.finishReason;
      usage = event.usage;
    }
  }
  if (!sawDone) throw new Error("Codex stream ended without a terminal event.");

  const message: Record<string, unknown> = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
  }
  sendJson(response, 200, {
    id,
    object: "chat.completion",
    created,
    model: request.model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage: openAIUsage(usage) } : {}),
  });
}

function completionChunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function writeSse(response: ServerResponse, data: unknown): void {
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function openAIUsage(usage: GatewayUsage) {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
  };
}

function getSessionId(request: IncomingMessage, fallback: string): string {
  const value = request.headers["x-session-id"] ?? request.headers["x-client-request-id"];
  return typeof value === "string" && value ? value : fallback;
}

function writeDebugRecord(
  sessionId: string,
  request: ChatCompletionRequest,
  model: { provider: string; model: string },
): void {
  const record = {
    session_id: sessionId,
    provider: model.provider,
    model: model.model,
    reasoning_effort: request.reasoning_effort ?? null,
    message: lastMessageText(request.messages),
  };
  console.log(JSON.stringify(record));
}

function lastMessageText(messages: unknown[]): string {
  const message = messages[messages.length - 1];
  if (!message || typeof message !== "object" || Array.isArray(message)) return "";
  const content = (message as Record<string, unknown>).content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => {
          if (!part || typeof part !== "object" || Array.isArray(part)) return "";
          const item = part as Record<string, unknown>;
          return item.type === "text" && typeof item.text === "string" ? item.text : "";
        }).join("")
      : "";
  return Array.from(text).slice(-20).join("");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new RequestError("Request body is too large.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError("Request body must be valid JSON.");
  }
}

function validateChatRequest(value: unknown): ChatCompletionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError("Request body must be a JSON object.");
  }
  const request = value as Partial<ChatCompletionRequest>;
  if (typeof request.model !== "string" || !request.model) {
    throw new RequestError("The 'model' field is required.");
  }
  if (!Array.isArray(request.messages)) {
    throw new RequestError("The 'messages' field must be an array.");
  }
  return request as ChatCompletionRequest;
}

class RequestError extends Error {}

function sendError(
  response: ServerResponse,
  status: number,
  type: string,
  message: string,
  code: string,
): void {
  sendJson(response, status, { error: { type, code, message } });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "The Codex request failed.";
}
