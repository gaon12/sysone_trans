import assert from "node:assert/strict";
import { test } from "node:test";
import { translate } from "../src/translate.js";
import type {
  DecisionClient,
  DecisionInput,
  TokenUsage,
} from "../src/types.js";

const character = (text: string) =>
  `CHAR_${text.codePointAt(0)?.toString(16).toUpperCase()}`;

function scripted(
  labels: (string | Error)[],
  usage: TokenUsage = {
    inputTokens: 10,
    outputTokens: 1,
    totalTokens: 11,
  },
): DecisionClient & { inputs: DecisionInput[] } {
  const inputs: DecisionInput[] = [];
  return {
    id: "test:scripted",
    inputs,
    async decide(input) {
      inputs.push(input);
      const label = labels.shift();
      if (label instanceof Error) throw label;
      if (label === undefined) throw new Error("Unexpected extra decision.");
      return {
        label,
        confidence: 0.8,
        probabilities: { [label]: 1 },
        resolvedModel: "test-pinned",
        usage,
      };
    },
  };
}

test("English sends the full source and immutable prefix at every decision", async () => {
  const client = scripted([character("H"), character("i"), "EOS"]);
  const result = await translate(client, {
    source: "안녕",
    sourceLanguage: "ko",
    targetLanguage: "en",
    maxChars: 2,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.text, "Hi");
  assert.equal(result.decisionCount, 3);
  assert.deepEqual(result.usage, {
    inputTokens: 30,
    outputTokens: 3,
    totalTokens: 33,
  });
  assert.deepEqual(
    client.inputs.map((input) => input.state.translation_so_far),
    ["", "H", "Hi"],
  );
  assert.ok(client.inputs.every((input) => input.state.source_text === "안녕"));
});

test("Korean forwards committed text and pending components separately", async () => {
  const client = scripted([
    "INITIAL_18",
    "MEDIAL_0",
    "FINAL_4",
    "INITIAL_0",
    "MEDIAL_18",
    "FINAL_8",
    "EOS",
  ]);
  const result = await translate(client, {
    source: "Hangul",
    sourceLanguage: "en",
    targetLanguage: "ko",
    maxChars: 2,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.text, "한글");
  assert.equal(result.maxDecisions, 7);
  assert.deepEqual(
    result.steps.map((step) => step.emitted),
    ["", "", "한", "", "", "글", ""],
  );
  assert.deepEqual(client.inputs[2]?.state.pending_syllable, {
    initial: "ㅎ",
    medial: "ㅏ",
  });
  assert.equal(client.inputs[3]?.state.translation_so_far, "한");
  assert.deepEqual(result.pendingSyllable, { initial: null, medial: null });
});

test("Japanese generates kana through the same translation loop", async () => {
  const client = scripted([...Array.from("こんにちは。", character), "EOS"]);
  const result = await translate(client, {
    source: "Hello.",
    targetLanguage: "ja",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.text, "こんにちは。");
  assert.match(client.inputs[0]?.instructions ?? "", /without kanji/);
});

test("character limits preserve partial output without claiming completion", async () => {
  const result = await translate(scripted([character("a"), character("b")]), {
    source: "안녕",
    targetLanguage: "en",
    maxChars: 1,
  });
  assert.equal(result.status, "max_chars");
  assert.equal(result.text, "a");
  assert.equal(result.steps[1]?.applied, false);
  assert.equal(result.decisionCount, 2);
});

test("decision limits preserve an unfinished Hangul syllable without emitting broken text", async () => {
  const result = await translate(scripted(["INITIAL_18", "MEDIAL_0"]), {
    source: "one",
    targetLanguage: "ko",
    maxDecisions: 2,
  });
  assert.equal(result.status, "max_decisions");
  assert.equal(result.text, "");
  assert.deepEqual(result.pendingSyllable, { initial: "ㅎ", medial: "ㅏ" });
});

test("unknown token usage stays unknown across the experiment", async () => {
  const result = await translate(
    scripted([character("a"), "EOS"], {
      inputTokens: null,
      outputTokens: 2,
      totalTokens: null,
    }),
    { source: "하나", targetLanguage: "en" },
  );
  assert.deepEqual(result.usage, {
    inputTokens: null,
    outputTokens: 4,
    totalTokens: null,
  });
});

test("provider failures keep successful prefixes and count the failed attempt", async () => {
  const result = await translate(
    scripted([
      character("H"),
      new Error("Decision request failed (HTTP 401)."),
    ]),
    {
      source: "안녕",
      targetLanguage: "en",
    },
  );
  assert.equal(result.status, "error");
  assert.equal(result.text, "H");
  assert.equal(result.decisionCount, 2);
  assert.equal(result.steps.length, 1);
  assert.match(result.error ?? "", /HTTP 401/);
});

test("cancellation stops before the next dependent request", async () => {
  const controller = new AbortController();
  const client = scripted([character("H"), character("i"), "EOS"]);
  const result = await translate(client, {
    source: "안녕",
    targetLanguage: "en",
    signal: controller.signal,
    onStep: () => controller.abort(),
  });
  assert.equal(result.status, "cancelled");
  assert.equal(result.text, "H");
  assert.equal(client.inputs.length, 1);
});

test("unavailable choices and empty EOS are recorded as failures", async () => {
  const result = await translate(scripted(["UNKNOWN"]), {
    source: "안녕",
    targetLanguage: "en",
  });
  assert.equal(result.status, "error");
  assert.equal(result.text, "");
  assert.equal(
    (
      await translate(scripted(["EOS"]), {
        source: "안녕",
        targetLanguage: "en",
      })
    ).status,
    "error",
  );
});

test("rejects invalid settings before making any requests", async () => {
  for (const overrides of [
    { source: " " },
    { maxChars: 0 },
    { maxDecisions: -1 },
    { maxChars: 1.5 },
  ]) {
    const client = scripted([]);
    await assert.rejects(
      translate(client, { source: "안녕", targetLanguage: "en", ...overrides }),
    );
    assert.equal(client.inputs.length, 0);
  }
});
