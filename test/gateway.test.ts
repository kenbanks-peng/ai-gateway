import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import {
  createGateway,
  type GatewayEvent,
  type UpstreamPort,
} from "../src/gateway.js";

const servers: Array<ReturnType<typeof createGateway>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((gateway) => gateway.close()));
});

function fakeUpstream(events: GatewayEvent[]): UpstreamPort {
  return {
    async *generate() {
      yield* events;
    },
  };
}

async function start(events: GatewayEvent[], debug = false) {
  const gateway = createGateway({
    models: [{ id: "gpt-test", provider: "openai-codex", created: 1 }],
    upstream: fakeUpstream(events),
    debug,
  });
  servers.push(gateway);
  await gateway.listen({ host: "127.0.0.1", port: 0 });
  const { port } = gateway.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

test("lists the Codex models through the OpenAI models interface", async () => {
  const baseUrl = await start([]);
  const response = await fetch(`${baseUrl}/v1/models`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    object: "list",
    data: [
      {
        id: "gpt-test",
        object: "model",
        created: 1,
        owned_by: "openai-codex",
      },
    ],
  });
});

test("writes the full client request in debug mode", async () => {
  const baseUrl = await start([{ type: "done", finishReason: "stop" }], true);
  const records: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => records.push(String(values[0]));
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "session-1" },
      body: JSON.stringify({
        model: "gpt-test",
        reasoning_effort: "high",
        messages: [{ role: "user", content: "123456789012345678901234" }],
      }),
    });
    assert.equal(response.status, 200);
  } finally {
    console.log = originalLog;
  }
  const record = JSON.parse(records[0] ?? "");
  assert.equal(record.session_id, "session-1");
  assert.equal(record.provider, "openai-codex");
  assert.equal(record.model, "gpt-test");
  assert.equal(record.request.body.reasoning_effort, "high");
  assert.equal(record.request.body.foo, undefined);
  assert.deepEqual(record.request.body.messages, [
    { role: "user", content: "123456789012345678901234" },
  ]);
  assert.equal(record.request.method, "POST");
  assert.equal(record.request.url, "/v1/chat/completions");
  assert.equal(record.request.headers["x-session-id"], "session-1");
});

test("returns a non-streamed chat completion with text, tool calls, and usage", async () => {
  const baseUrl = await start([
    { type: "text", delta: "I will check." },
    {
      type: "tool_call",
      index: 0,
      id: "call_1",
      name: "read_file",
      argumentsDelta: '{"path":"a.ts"}',
    },
    {
      type: "done",
      finishReason: "tool_calls",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    },
  ]);

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-test",
      messages: [{ role: "user", content: "Check a.ts" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read one file",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    }),
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "gpt-test");
  assert.deepEqual(body.choices, [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "I will check.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ]);
  assert.deepEqual(body.usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  });
});

test("streams OpenAI chat chunks and a terminal done marker", async () => {
  const baseUrl = await start([
    { type: "reasoning", delta: "brief thought" },
    { type: "text", delta: "Hello" },
    { type: "done", finishReason: "stop" },
  ]);

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-test",
      stream: true,
      messages: [{ role: "user", content: "Hello" }],
    }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  const text = await response.text();
  assert.match(text, /"delta":\{"role":"assistant"\}/);
  assert.match(text, /"reasoning_content":"brief thought"/);
  assert.match(text, /"content":"Hello"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.match(text, /data: \[DONE\]\n\n$/);
});

test("returns an upstream error when a non-streamed event sequence has no terminal event", async () => {
  const baseUrl = await start([{ type: "text", delta: "partial" }]);
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }],
    }),
  });

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: {
      type: "upstream_error",
      code: "upstream_error",
      message: "Codex stream ended without a terminal event.",
    },
  });
});

test("rejects unknown models before it calls the upstream", async () => {
  const baseUrl = await start([]);
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "missing", messages: [] }),
  });

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: {
      type: "invalid_request_error",
      code: "model_not_found",
      message: "Model 'missing' does not exist.",
    },
  });
});
