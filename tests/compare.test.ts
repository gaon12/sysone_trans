import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, summarize } from "../src/compare.js";
import type { DecisionClient } from "../src/types.js";

function client(id: string, fail = false): DecisionClient {
  return {
    id,
    async decide(input) {
      if (fail) throw new Error("Decision request failed (HTTP 401).");
      const label = input.state.translation_so_far ? "EOS" : "CHAR_41";
      return {
        label,
        probabilities: null,
        confidence: null,
        resolvedModel: `${id}-pinned`,
        usage: { inputTokens: null, outputTokens: null, totalTokens: null },
      };
    },
  };
}

test("compares every model/target/repetition and rotates model order", async () => {
  const order: string[] = [];
  let steps = 0;
  const runs = await compare(
    {
      source: "안녕",
      models: ["typesafe:a", "openai:b"],
      targets: ["en", "ja"],
      repetitions: 2,
      onRunStart: (model, target, repetition) =>
        order.push(`${repetition}:${target}:${model}`),
      onStep: () => steps++,
    },
    (id) => client(id),
  );
  assert.equal(runs.length, 8);
  assert.equal(steps, 16);
  assert.deepEqual(order, [
    "1:en:typesafe:a",
    "1:en:openai:b",
    "1:ja:typesafe:a",
    "1:ja:openai:b",
    "2:en:openai:b",
    "2:en:typesafe:a",
    "2:ja:openai:b",
    "2:ja:typesafe:a",
  ]);
  assert.ok(runs.every((run) => run.result.status === "completed"));
  assert.equal(summarize(runs).length, 4);
});

test("one provider failure does not prevent other comparisons", async () => {
  const runs = await compare(
    {
      source: "안녕",
      models: ["typesafe:bad", "openai:good"],
      targets: ["en"],
    },
    (id) => client(id, id.endsWith("bad")),
  );
  assert.deepEqual(
    runs.map((run) => run.result.status),
    ["error", "completed"],
  );
  const rows = summarize(runs);
  assert.equal(rows[0]?.completionRate, 0);
  assert.equal(rows[0]?.meanDurationMs, null);
  assert.equal(rows[1]?.completionRate, 1);
  assert.equal(rows[1]?.meanDecisions, 2);
});

test("credential and setting errors fail preflight before any decisions", async () => {
  let calls = 0;
  await assert.rejects(
    compare(
      {
        source: "안녕",
        models: ["typesafe:good", "openai:missing"],
        targets: ["en"],
      },
      (id) => {
        if (id.endsWith("missing")) throw new Error("Set OPENAI_API_KEY.");
        const model = client(id);
        return {
          id,
          async decide(input) {
            calls++;
            return model.decide(input);
          },
        };
      },
    ),
    /OPENAI_API_KEY/,
  );
  await assert.rejects(
    compare(
      { source: " ", models: ["typesafe:good"], targets: ["en"] },
      client,
    ),
    /empty/,
  );
  assert.equal(calls, 0);
});

test("cancellation preserves completed runs and stops the remaining matrix", async () => {
  const controller = new AbortController();
  const runs = await compare(
    {
      source: "안녕",
      models: ["typesafe:a", "openai:b"],
      targets: ["en"],
      repetitions: 2,
      signal: controller.signal,
      onStep: (step) => {
        if (step.label === "EOS") controller.abort();
      },
    },
    client,
  );
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.result.status, "completed");
});

test("rejects empty, duplicate, and invalid comparison matrices", async () => {
  for (const settings of [
    { models: [], targets: ["en"] as const },
    { models: ["typesafe:a"], targets: [] },
    { models: ["typesafe:a", "typesafe:a"], targets: ["en"] as const },
    { models: ["typesafe:a"], targets: ["en", "en"] as const },
    { models: ["typesafe:a"], targets: ["en"] as const, repetitions: 0 },
  ])
    await assert.rejects(compare({ source: "안녕", ...settings }, client));
});
