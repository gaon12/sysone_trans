import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli.js";
import type { DecisionClient } from "../src/types.js";

function harness() {
  let stdout = "";
  let stderr = "";
  let calls = 0;
  const dependencies = {
    writeOutput: (text: string) => {
      stdout += text;
    },
    writeError: (text: string) => {
      stderr += text;
    },
    createClient: (id: string): DecisionClient => ({
      id,
      async decide(input) {
        calls++;
        const label = input.state.translation_so_far ? "EOS" : "CHAR_41";
        return {
          label,
          resolvedModel: "test-pinned",
          probabilities: { [label]: 1 },
          confidence: 0.8,
          usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
        };
      },
    }),
  };
  return {
    dependencies,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get calls() {
      return calls;
    },
  };
}

test("help succeeds without credentials or requests", async () => {
  const io = harness();
  assert.equal(await runCli(["--help"], io.dependencies), 0);
  assert.match(io.stdout, /BYOK/);
  assert.equal(io.calls, 0);
});

test("single translation streams output and prints optional native probabilities", async () => {
  const io = harness();
  assert.equal(
    await runCli(["--show-probabilities", "안녕"], io.dependencies),
    0,
  );
  assert.match(io.stdout, /> A\n/);
  assert.match(io.stdout, /\[completed, run 1\]/);
  assert.match(io.stderr, /100.00%/);
  assert.equal(io.calls, 2);
});

test("comparison exports reproducible settings, complete traces, and summaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sysone-report-"));
  try {
    const path = join(directory, "nested", "report.json");
    const io = harness();
    assert.equal(
      await runCli(
        [
          "--compare",
          "--to",
          "en,ja,ko",
          "--repeat",
          "2",
          "--show-probabilities",
          "--json",
          path,
          "안녕",
        ],
        io.dependencies,
      ),
      0,
    );
    const report = JSON.parse(await readFile(path, "utf8"));
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.runs.length, 12);
    assert.equal(report.summary.length, 6);
    assert.deepEqual(report.settings.models, [
      "typesafe:jev-latest",
      "openai:gpt-6-luna",
    ]);
    assert.equal(report.settings.repetitions, 2);
    assert.equal(report.runs[0].result.steps[0].resolvedModel, "test-pinned");
    assert.ok(report.runtime.dependencies.ai);
    assert.equal(report.interrupted, false);
    assert.match(io.stderr, /100.00%/);
    assert.doesNotMatch(JSON.stringify(report), /apiKey|Authorization|Bearer/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid CLI arguments fail before a provider request", async () => {
  for (const args of [
    ["--to", "zh", "안녕"],
    ["--from", "unknown", "안녕"],
    ["--repeat", "1.2", "안녕"],
    ["--max-chars", "0", "안녕"],
    ["--retries", "-1", "안녕"],
    ["--models", "typesafe:a,typesafe:a", "안녕"],
    ["--model", "typesafe:a", "--models", "openai:b", "안녕"],
    ["--unknown", "안녕"],
    ["two", "arguments"],
  ]) {
    const io = harness();
    assert.equal(await runCli(args, io.dependencies), 1);
    assert.match(io.stderr, /Error:/);
    assert.equal(io.calls, 0);
  }
});

test("refuses to overwrite an existing report before making paid requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sysone-existing-"));
  try {
    const path = join(directory, "report.json");
    await writeFile(path, "existing report");
    const io = harness();
    assert.equal(await runCli(["--json", path, "안녕"], io.dependencies), 1);
    assert.equal(io.calls, 0);
    assert.equal(await readFile(path, "utf8"), "existing report");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("source text can be supplied by stdin without a positional argument", async () => {
  const io = harness();
  assert.equal(
    await runCli([], { ...io.dependencies, readSource: async () => "안녕" }),
    0,
  );
  assert.equal(io.calls, 2);
});

test("incomplete output returns a failing process status", async () => {
  const io = harness();
  assert.equal(
    await runCli(["--max-decisions", "1", "안녕"], io.dependencies),
    1,
  );
  assert.match(io.stdout, /max_decisions/);
});

test("cancellation returns exit status 130 and sends no further decisions", async () => {
  const io = harness();
  assert.equal(
    await runCli(["안녕"], { ...io.dependencies, signal: AbortSignal.abort() }),
    130,
  );
  assert.equal(io.calls, 0);
});
