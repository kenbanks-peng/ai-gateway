import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import { PiCodexUpstream, type PiRuntime } from "../src/pi-codex-upstream.js";

const model = {
  id: "gpt-test",
  name: "GPT Test",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
} as Model<"openai-codex-responses">;

function output(content: AssistantMessage["content"] = []): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 7,
      output: 3,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

async function* eventStream(events: AssistantMessageEvent[]) {
  yield* events;
}

test("translates a Chat Completions conversation to Pi and maps Pi events back", async () => {
  let capturedContext: Context | undefined;
  let capturedOptions: Record<string, unknown> | undefined;
  const final = output([
    { type: "text", text: "Done" },
    { type: "toolCall", id: "call_2", name: "write", arguments: { ok: true } },
  ]);
  final.stopReason = "toolUse";

  const runtime: PiRuntime = {
    models: [model],
    stream(_model, context, options) {
      capturedContext = context;
      capturedOptions = options;
      return eventStream([
        { type: "text_delta", contentIndex: 0, delta: "Done", partial: final },
        {
          type: "toolcall_delta",
          contentIndex: 1,
          delta: '{"ok":true}',
          partial: final,
        },
        { type: "done", reason: "toolUse", message: final },
      ]);
    },
  };
  const upstream = new PiCodexUpstream(runtime);

  const events = [];
  for await (const event of upstream.generate(
    {
      model: "gpt-test",
      reasoning_effort: "high",
      max_completion_tokens: 200,
      messages: [
        { role: "system", content: "Be exact." },
        { role: "user", content: "Write it." },
        {
          role: "assistant",
          content: "I can.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "write", arguments: '{"path":"a"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", name: "write", content: "ok" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "write",
            description: "Write a file",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    },
    { signal: new AbortController().signal, sessionId: "session-1" },
  )) {
    events.push(event);
  }

  assert.equal(capturedContext?.systemPrompt, "Be exact.");
  assert.deepEqual(capturedContext?.messages.map((message) => message.role), [
    "user",
    "assistant",
    "toolResult",
  ]);
  assert.deepEqual(capturedContext?.tools?.[0], {
    name: "write",
    description: "Write a file",
    parameters: { type: "object", properties: {} },
  });
  assert.deepEqual(capturedOptions, {
    signal: capturedOptions?.signal,
    sessionId: "session-1",
    reasoningEffort: "high",
    maxTokens: 200,
  });
  assert.deepEqual(events, [
    { type: "text", delta: "Done" },
    {
      type: "tool_call",
      index: 0,
      id: "call_2",
      name: "write",
      argumentsDelta: '{"ok":true}',
    },
    {
      type: "done",
      finishReason: "tool_calls",
      usage: { promptTokens: 9, completionTokens: 3, totalTokens: 12 },
    },
  ]);
});
