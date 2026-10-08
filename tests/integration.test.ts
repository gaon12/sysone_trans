import assert from "node:assert/strict";
import { test } from "node:test";
import { createDecisionClient } from "../src/providers.js";
import { translate } from "../src/translate.js";
import type { Language } from "../src/types.js";

const examples: { target: Language; text: string; labels: string[] }[] = [
  {
    target: "en",
    text: "Hi.",
    labels: ["CHAR_48", "CHAR_69", "CHAR_2E", "EOS"],
  },
  {
    target: "ja",
    text: "はい。",
    labels: ["CHAR_306F", "CHAR_3044", "CHAR_3002", "EOS"],
  },
  {
    target: "ko",
    text: "한글",
    labels: [
      "INITIAL_18",
      "MEDIAL_0",
      "FINAL_4",
      "INITIAL_0",
      "MEDIAL_18",
      "FINAL_8",
      "EOS",
    ],
  },
];

for (const provider of ["typesafe", "openai"] as const) {
  for (const example of examples) {
    test(`${provider} SDK decisions generate complete ${example.target} output through mocked native HTTP`, async () => {
      let requests = 0;
      const client = createDecisionClient(
        `${provider}:${provider === "typesafe" ? "jev-latest" : "gpt-6-luna"}`,
        {
          apiKeys: { [provider]: "integration-test-key" },
          maxRetries: 0,
          fetch: async (_url, init) => {
            const payload = JSON.parse(String(init?.body));
            const state =
              provider === "typesafe"
                ? payload.state
                : JSON.parse(payload.input);
            assert.equal(state.source_text, "안녕");
            assert.equal(state.target_language, example.target);
            const labels: string[] =
              provider === "typesafe"
                ? Object.keys(payload.questions.next_unit.criteria)
                : payload.questions[0].choices.map(
                    (choice: { value: string }) => choice.value,
                  );
            const selected = example.labels[requests++];
            assert.ok(selected && labels.includes(selected));
            const probabilities = Object.fromEntries(
              labels.map((label) => [label, label === selected ? 1 : 0]),
            );
            return Response.json({
              model: `${provider}-test-pinned`,
              usage: { input_tokens: 10, output_tokens: 1 },
              answers:
                provider === "typesafe"
                  ? {
                      next_unit: {
                        type: "choice",
                        choice: selected,
                        confidence: 0.9,
                        probabilities,
                      },
                    }
                  : [
                      {
                        name: "next_unit",
                        type: "choice",
                        choice: selected,
                        confidence: 0.9,
                        probabilities: Object.entries(probabilities).map(
                          ([value, probability]) => ({ value, probability }),
                        ),
                      },
                    ],
            });
          },
        },
      );
      const result = await translate(client, {
        source: "안녕",
        targetLanguage: example.target,
      });
      assert.equal(result.status, "completed");
      assert.equal(result.text, example.text);
      assert.equal(requests, example.labels.length);
      assert.equal(result.usage.totalTokens, requests * 11);
      assert.ok(result.steps.every((step) => step.confidence === 0.9));
    });
  }
}
