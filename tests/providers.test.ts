import assert from "node:assert/strict";
import { test } from "node:test";
import { createDecisionClient, parseModelId } from "../src/providers.js";
import type { DecisionInput } from "../src/types.js";

const input: DecisionInput = {
  state: { source: "안녕", prefix: "H" },
  instructions: "Choose the next character.",
  options: [
    { label: "I", description: "Lowercase i" },
    { label: "EOS", description: "Translation is complete" },
  ],
};

function jevResponse(choice = "I") {
  return {
    model: "jev-pinned-test",
    answers: {
      next_unit: {
        type: "choice",
        choice,
        probabilities: { I: 0.9, EOS: 0.1 },
        confidence: 0.8,
      },
    },
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

test("Jev uses direct BYOK auth and preserves native probabilities and usage", async () => {
  const client = createDecisionClient("typesafe:jev-latest", {
    environment: { TYPESAFE_API_KEY: "jev-test-key" },
    fetch: async (url, init) => {
      assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer jev-test-key",
      );
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.model, "jev-latest");
      assert.deepEqual(payload.state, input.state);
      assert.deepEqual(payload.questions.next_unit.criteria, {
        I: "Lowercase i",
        EOS: "Translation is complete",
      });
      return Response.json(jevResponse());
    },
  });
  assert.deepEqual(await client.decide(input), {
    label: "I",
    probabilities: { I: 0.9, EOS: 0.1 },
    confidence: 0.8,
    resolvedModel: "jev-pinned-test",
    usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
  });
});

test("OpenAI calls the Decisions endpoint and maps the same choice question", async () => {
  const client = createDecisionClient("openai:gpt-6-luna", {
    apiKeys: { openai: "explicit-test-key" },
    environment: { OPENAI_API_KEY: "unused-test-key" },
    fetch: async (url, init) => {
      assert.equal(String(url), "https://api.openai.com/v1/decisions");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer explicit-test-key",
      );
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.model, "gpt-6-luna");
      assert.deepEqual(JSON.parse(payload.input), input.state);
      assert.deepEqual(payload.questions[0], {
        name: "next_unit",
        type: "choice",
        instructions: input.instructions,
        choices: input.options.map(({ label, description }) => ({
          value: label,
          description,
        })),
      });
      return Response.json({
        id: "decision_test",
        model: "gpt-6-luna",
        answers: [
          {
            name: "next_unit",
            type: "choice",
            choice: "I",
            confidence: 0.7,
            probabilities: [
              { value: "I", probability: 0.9 },
              { value: "EOS", probability: 0.1 },
            ],
          },
        ],
        usage: { input_tokens: 80, output_tokens: 5 },
      });
    },
  });
  const decision = await client.decide(input);
  assert.equal(decision.label, "I");
  assert.equal(decision.confidence, 0.7);
  assert.deepEqual(decision.probabilities, { I: 0.9, EOS: 0.1 });
  assert.equal(decision.usage.totalTokens, 85);
});

test("rejects missing keys and unsupported model namespaces before requests", () => {
  assert.throws(
    () => createDecisionClient("openai:gpt-6-luna", { environment: {} }),
    /OPENAI_API_KEY/,
  );
  for (const id of ["jev-latest", "other:test", "typesafe:", "openai: model"]) {
    assert.throws(() => parseModelId(id), /model ID/);
  }
  assert.deepEqual(parseModelId("typesafe:version:custom"), {
    provider: "typesafe",
    model: "version:custom",
  });
});

test("accepts the SDK key alias without requiring credentials for other providers", () => {
  assert.equal(
    createDecisionClient("typesafe:jev-latest", {
      environment: { TYPESAFE_AI_API_KEY: "alias-key" },
    }).id,
    "typesafe:jev-latest",
  );
});

test("missing token usage remains unknown rather than becoming zero", async () => {
  const { usage: _usage, ...response } = jevResponse();
  const client = createDecisionClient("typesafe:jev-latest", {
    apiKeys: { typesafe: "test-key" },
    fetch: async () => Response.json(response),
  });
  assert.deepEqual((await client.decide(input)).usage, {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
  });
});

test("rejects unknown choices and malformed probability distributions", async () => {
  for (const response of [
    jevResponse("UNKNOWN"),
    {
      ...jevResponse(),
      answers: {
        next_unit: {
          ...jevResponse().answers.next_unit,
          probabilities: { I: 0.2, EOS: 0.1 },
        },
      },
    },
  ]) {
    const client = createDecisionClient("typesafe:jev-latest", {
      apiKeys: { typesafe: "test-key" },
      maxRetries: 0,
      fetch: async () => Response.json(response),
    });
    await assert.rejects(client.decide(input), /invalid or refused/);
  }
});

test("authentication errors expose status without echoing keys or response bodies", async () => {
  let requests = 0;
  const client = createDecisionClient("typesafe:jev-latest", {
    apiKeys: { typesafe: "private-key" },
    fetch: async () => {
      requests++;
      return Response.json(
        { message: "private-key and sensitive source" },
        { status: 401 },
      );
    },
  });
  await assert.rejects(client.decide(input), {
    message: "Decision request failed (HTTP 401).",
  });
  assert.equal(requests, 1);
});

test("retries a temporary provider error through the SDK", async () => {
  let requests = 0;
  const client = createDecisionClient("typesafe:jev-latest", {
    apiKeys: { typesafe: "test-key" },
    maxRetries: 1,
    fetch: async () =>
      ++requests === 1
        ? Response.json(
            { message: "Busy" },
            { status: 429, headers: { "retry-after": "0" } },
          )
        : Response.json(jevResponse()),
  });
  assert.equal((await client.decide(input)).label, "I");
  assert.equal(requests, 2);
});

test("an already cancelled translation never sends a request", async () => {
  let requests = 0;
  const client = createDecisionClient("typesafe:jev-latest", {
    apiKeys: { typesafe: "test-key" },
    fetch: async () => {
      requests++;
      return Response.json(jevResponse());
    },
  });
  await assert.rejects(client.decide(input, AbortSignal.abort()), /cancelled/);
  assert.equal(requests, 0);
});

test("rejects duplicate candidates before sending a request", async () => {
  const client = createDecisionClient("typesafe:jev-latest", {
    apiKeys: { typesafe: "test-key" },
  });
  await assert.rejects(
    client.decide({
      ...input,
      options: [
        { label: "I", description: "First" },
        { label: "I", description: "Duplicate" },
      ],
    }),
    /unique labels/,
  );
});

test("native OpenAI refusals do not become output characters", async () => {
  const client = createDecisionClient("openai:gpt-6-luna", {
    apiKeys: { openai: "test-key" },
    maxRetries: 0,
    fetch: async () =>
      Response.json({ answers: [{ name: "next_unit", type: "refusal" }] }),
  });
  await assert.rejects(client.decide(input), /invalid or refused/);
});

test("the decision deadline cancels a stalled HTTP request", async () => {
  const client = createDecisionClient("typesafe:jev-latest", {
    apiKeys: { typesafe: "test-key" },
    timeoutMs: 5,
    maxRetries: 0,
    fetch: async (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(Response.json(jevResponse())),
          100,
        );
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          },
          { once: true },
        );
      }),
  });
  await assert.rejects(client.decide(input), /timed out/);
});

test("OpenAI enforces its two-choice minimum before an HTTP request", async () => {
  let requests = 0;
  const client = createDecisionClient("openai:gpt-6-luna", {
    apiKeys: { openai: "test-key" },
    fetch: async () => {
      requests++;
      return Response.json({});
    },
  });
  await assert.rejects(
    client.decide({
      ...input,
      options: [{ label: "EOS", description: "Translation is complete" }],
    }),
    /2–255/,
  );
  assert.equal(requests, 0);
});
