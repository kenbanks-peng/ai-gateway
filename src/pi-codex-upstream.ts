import {
  createModels,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type CredentialStore,
  type Message,
  type Model,
  type Tool,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type {
  ChatCompletionRequest,
  GatewayEvent,
  UpstreamPort,
} from "./gateway.js";

export interface PiRuntime {
  models: readonly Model<"openai-codex-responses">[];
  stream(
    model: Model<"openai-codex-responses">,
    context: Context,
    options: Record<string, unknown>,
  ): AsyncIterable<AssistantMessageEvent>;
}

export class PiCodexUpstream implements UpstreamPort {
  constructor(private readonly runtime: PiRuntime) {}

  async *generate(
    request: ChatCompletionRequest,
    options: { signal: AbortSignal; sessionId: string },
  ): AsyncIterable<GatewayEvent> {
    const model = this.runtime.models.find((candidate) => candidate.id === request.model);
    if (!model) throw new Error(`Codex model '${request.model}' is not available.`);

    const context = toPiContext(request, model);
    const streamOptions: Record<string, unknown> = {
      signal: options.signal,
      sessionId: options.sessionId,
    };
    const reasoningEffort = toReasoningEffort(request.reasoning_effort);
    if (reasoningEffort) streamOptions.reasoningEffort = reasoningEffort;
    const maxTokens = request.max_completion_tokens ?? request.max_tokens;
    if (typeof maxTokens === "number") streamOptions.maxTokens = maxTokens;
    if (typeof request.temperature === "number") streamOptions.temperature = request.temperature;
    const toolChoice = toToolChoice(request.tool_choice);
    if (toolChoice) streamOptions.toolChoice = toolChoice;

    const toolIndexes = new Map<number, number>();
    for await (const event of this.runtime.stream(model, context, streamOptions)) {
      const mapped = mapPiEvent(event, toolIndexes);
      if (mapped) yield mapped;
    }
  }
}

export function createPiCodexRuntime(credentials: CredentialStore): PiRuntime {
  const models = createModels({ credentials });
  const provider = openaiCodexProvider();
  models.setProvider(provider);
  return {
    models: provider.getModels(),
    stream(model, context, options) {
      return models.stream(model, context, options);
    },
  };
}

function toPiContext(
  request: ChatCompletionRequest,
  model: Model<"openai-codex-responses">,
): Context {
  const systemParts: string[] = [];
  const messages: Message[] = [];
  const toolNames = new Map<string, string>();

  for (const value of request.messages) {
    const message = asRecord(value, "Each message must be an object.");
    const role = message.role;
    if (role === "system" || role === "developer") {
      systemParts.push(textOnlyContent(message.content));
    } else if (role === "user") {
      messages.push({
        role: "user",
        content: userContent(message.content),
        timestamp: Date.now(),
      });
    } else if (role === "assistant") {
      const assistant = assistantMessage(message, model);
      messages.push(assistant);
      for (const block of assistant.content) {
        if (block.type === "toolCall") toolNames.set(block.id, block.name);
      }
    } else if (role === "tool") {
      const toolCallId = requiredString(message.tool_call_id, "Tool messages need 'tool_call_id'.");
      const toolName =
        optionalString(message.name) ?? toolNames.get(toolCallId) ?? "tool";
      messages.push({
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text: textOnlyContent(message.content) }],
        isError: false,
        timestamp: Date.now(),
      });
    } else {
      throw new Error(`Unsupported message role '${String(role)}'.`);
    }
  }

  const context: Context = { messages };
  if (systemParts.length) context.systemPrompt = systemParts.join("\n\n");
  const tools = toPiTools(request.tools);
  if (tools.length) context.tools = tools;
  return context;
}

function assistantMessage(
  message: Record<string, unknown>,
  model: Model<"openai-codex-responses">,
): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  const text = nullableTextContent(message.content);
  if (text) content.push({ type: "text", text });
  const reasoning = optionalString(message.reasoning_content);
  if (reasoning) content.push({ type: "thinking", thinking: reasoning });
  if (Array.isArray(message.tool_calls)) {
    for (const value of message.tool_calls) {
      const call = asRecord(value, "Each tool call must be an object.");
      const fn = asRecord(call.function, "Each tool call needs a function.");
      content.push({
        type: "toolCall",
        id: requiredString(call.id, "Each tool call needs an id."),
        name: requiredString(fn.name, "Each tool call needs a function name."),
        arguments: parseArguments(fn.arguments),
      });
    }
  }
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

function userContent(value: unknown) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw new Error("User message content must be text or an array.");
  return value.map((part) => {
    const item = asRecord(part, "Each content part must be an object.");
    if (item.type === "text") {
      return { type: "text" as const, text: requiredString(item.text, "Text content needs text.") };
    }
    if (item.type === "image_url") {
      const image = asRecord(item.image_url, "Image content needs 'image_url'.");
      const url = requiredString(image.url, "Image content needs a URL.");
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
      if (!match?.[1] || !match[2]) {
        throw new Error("Only base64 data URLs are supported for image input.");
      }
      return { type: "image" as const, mimeType: match[1], data: match[2] };
    }
    throw new Error(`Unsupported content type '${String(item.type)}'.`);
  });
}

function toPiTools(values: unknown[] | undefined): Tool[] {
  if (!values) return [];
  return values.map((value) => {
    const item = asRecord(value, "Each tool must be an object.");
    if (item.type !== "function") throw new Error("Only function tools are supported.");
    const fn = asRecord(item.function, "Each function tool needs a function.");
    return {
      name: requiredString(fn.name, "Each function tool needs a name."),
      description: optionalString(fn.description) ?? "",
      parameters: asRecord(fn.parameters ?? { type: "object", properties: {} }, "Tool parameters must be an object.") as Tool["parameters"],
    };
  });
}

function mapPiEvent(
  event: AssistantMessageEvent,
  toolIndexes: Map<number, number>,
): GatewayEvent | undefined {
  if (event.type === "text_delta") return { type: "text", delta: event.delta };
  if (event.type === "thinking_delta") return { type: "reasoning", delta: event.delta };
  if (event.type === "toolcall_delta") {
    const block = event.partial.content[event.contentIndex];
    if (!block || block.type !== "toolCall") return undefined;
    let index = toolIndexes.get(event.contentIndex);
    if (index === undefined) {
      index = toolIndexes.size;
      toolIndexes.set(event.contentIndex, index);
    }
    return {
      type: "tool_call",
      index,
      id: block.id,
      name: block.name,
      argumentsDelta: event.delta,
    };
  }
  if (event.type === "done") {
    return {
      type: "done",
      finishReason:
        event.reason === "toolUse" ? "tool_calls" : event.reason === "length" ? "length" : "stop",
      usage: {
        promptTokens:
          event.message.usage.input +
          event.message.usage.cacheRead +
          event.message.usage.cacheWrite,
        completionTokens: event.message.usage.output,
        totalTokens: event.message.usage.totalTokens,
      },
    };
  }
  if (event.type === "error") throw new Error(event.error.errorMessage ?? "Codex request failed.");
  return undefined;
}

function toReasoningEffort(value: string | undefined) {
  return value && ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
    ? value
    : undefined;
}

function toToolChoice(value: unknown): "auto" | "none" | "required" | undefined {
  return value === "auto" || value === "none" || value === "required" ? value : undefined;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value) return {};
  try {
    return asRecord(JSON.parse(value), "Tool arguments must be a JSON object.");
  } catch {
    throw new Error("Tool arguments must be valid JSON.");
  }
}

function nullableTextContent(value: unknown): string {
  return value == null ? "" : textOnlyContent(value);
}

function textOnlyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const item = asRecord(part, "Each content part must be an object.");
        return item.type === "text" ? requiredString(item.text, "Text content needs text.") : "";
      })
      .join("");
  }
  throw new Error("Message content must be text.");
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value) throw new Error(message);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
