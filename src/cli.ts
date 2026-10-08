import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { compare, type ExperimentRun, summarize } from "./compare.js";
import { FINALS, INITIALS, MEDIALS } from "./output.js";
import {
  createDecisionClient,
  DEFAULT_MODELS,
  parseModelId,
} from "./providers.js";
import {
  type SourceLanguage,
  type TranslationStep,
  translate,
  validateTranslationSettings,
} from "./translate.js";
import type { DecisionClient, Language } from "./types.js";

const HELP = `Usage:
  npm run translate -- [options] "source text"
  npm run compare -- --models typesafe:jev-latest,openai:gpt-6-luna [options] "source text"

Options:
  --model <provider:model>   One native decision model (default: typesafe:jev-latest)
  --models <id,id>           Compare multiple native decision models
  --from <auto|en|ja|ko>     Source language (default: auto)
  --to <en|ja|ko,...>        Target language(s) (default: en)
  --repeat <count>          Repetitions per model and target (default: 1)
  --max-chars <count>       Output character cap (default: 500)
  --max-decisions <count>   Request cap (default: chars * 1 or 3, plus EOS)
  --timeout-ms <ms>         Deadline per decision, including retries (default: 30000)
  --retries <count>         SDK retries per decision (default: 2)
  --show-probabilities      Show the eight leading options at each step
  --json <path>             Save settings, traces, and summaries; refuses overwrite
  --compare                 Compare default Jev and OpenAI models
  --help                    Show this help

BYOK: set TYPESAFE_API_KEY and/or OPENAI_API_KEY in your environment or local .env.
Japanese output uses kana without kanji. Korean uses initial/medial/final choices.
If source text is omitted, read it from stdin or prompt in an interactive terminal.
`;

export interface CliDependencies {
  createClient?: (id: string) => DecisionClient;
  writeOutput?: (text: string) => void;
  writeError?: (text: string) => void;
  readSource?: () => Promise<string>;
  signal?: AbortSignal;
}

function integer(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum = 1,
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value))
    throw new Error(`${name} must be an integer of at least ${minimum}.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum)
    throw new Error(`${name} must be an integer of at least ${minimum}.`);
  return number;
}

async function readSource(): Promise<string> {
  if (process.stdin.isTTY) {
    const reader = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await reader.question("Source text: ");
    } finally {
      reader.close();
    }
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trimEnd();
}

function displayLabel(label: string): string {
  if (label.startsWith("CHAR_"))
    return JSON.stringify(
      String.fromCodePoint(Number.parseInt(label.slice(5), 16)),
    );
  const [kind, index] = label.split("_");
  const letters =
    kind === "INITIAL"
      ? INITIALS
      : kind === "MEDIAL"
        ? MEDIALS
        : kind === "FINAL"
          ? FINALS
          : null;
  return letters ? `${kind}:${letters[Number(index)] || "no batchim"}` : label;
}

function printProbabilities(
  step: TranslationStep,
  write: (text: string) => void,
): void {
  const top = Object.entries(step.probabilities ?? {})
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(
      ([label, probability]) =>
        `${displayLabel(label)}=${(probability * 100).toFixed(2)}%`,
    )
    .join(" ");
  write(
    `[${step.index} ${step.stage}] ${displayLabel(step.label)}; confidence=${step.confidence ?? "unknown"}; ${step.durationMs.toFixed(1)} ms\n  ${top || "Probabilities unavailable"}\n`,
  );
}

/** Parse and run the CLI; injectable clients keep end-to-end tests offline. */
export async function runCli(
  argv: string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const output =
    dependencies.writeOutput ?? ((text) => process.stdout.write(text));
  const errorOutput =
    dependencies.writeError ?? ((text) => process.stderr.write(text));
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        model: { type: "string" },
        models: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        repeat: { type: "string" },
        "max-chars": { type: "string" },
        "max-decisions": { type: "string" },
        "timeout-ms": { type: "string" },
        retries: { type: "string" },
        "show-probabilities": { type: "boolean" },
        json: { type: "string" },
        compare: { type: "boolean" },
        help: { type: "boolean" },
      },
    });
    if (values.help) {
      output(HELP);
      return 0;
    }
    if (positionals.length > 1)
      throw new Error("Quote source text as one command-line argument.");
    if (values.model && values.models)
      throw new Error("Use either --model or --models.");
    const models = values.models
      ? values.models.split(",").map((model) => model.trim())
      : values.model
        ? [values.model]
        : values.compare
          ? [...DEFAULT_MODELS]
          : [DEFAULT_MODELS[0]];
    for (const model of models) parseModelId(model);
    const targets = (values.to ?? "en")
      .split(",")
      .map((target) => target.trim());
    if (targets.some((target) => !["en", "ja", "ko"].includes(target)))
      throw new Error("Target language must be en, ja, or ko.");
    const repetitions = integer(values.repeat, 1, "--repeat");
    if (
      new Set(models).size !== models.length ||
      new Set(targets).size !== targets.length
    )
      throw new Error(
        "Models and target languages must not contain duplicates.",
      );
    const source =
      positionals[0] ?? (await (dependencies.readSource ?? readSource)());
    const sourceLanguage = (values.from ?? "auto") as SourceLanguage;
    const maxChars = integer(values["max-chars"], 500, "--max-chars");
    const maxDecisions =
      values["max-decisions"] === undefined
        ? undefined
        : integer(values["max-decisions"], 1, "--max-decisions");
    const timeoutMs = integer(values["timeout-ms"], 30_000, "--timeout-ms");
    if (timeoutMs > 2 ** 32 - 1)
      throw new Error("--timeout-ms must be below 2^32.");
    const maxRetries = integer(values.retries, 2, "--retries", 0);
    for (const targetLanguage of targets as Language[])
      validateTranslationSettings({
        source,
        sourceLanguage,
        targetLanguage,
        maxChars,
        maxDecisions,
      });
    const outputPath =
      values.json === undefined ? undefined : resolve(values.json);
    if (outputPath && existsSync(outputPath))
      throw new Error(
        "The JSON output file already exists. Choose a new path.",
      );
    const createClient =
      dependencies.createClient ??
      ((id) => createDecisionClient(id, { timeoutMs, maxRetries }));
    // Preflight every provider before streaming output or starting the comparison.
    const clients = new Map(models.map((id) => [id, createClient(id)]));
    const findClient = (id: string) => {
      const client = clients.get(id);
      if (!client) throw new Error("Model was not configured.");
      return client;
    };
    const isComparison =
      values.compare ||
      models.length > 1 ||
      targets.length > 1 ||
      repetitions > 1;
    const onStep = (step: TranslationStep) => {
      if (!isComparison) output(step.emitted);
      if (values["show-probabilities"]) printProbabilities(step, errorOutput);
    };
    const settings = {
      source,
      sourceLanguage,
      maxChars,
      maxDecisions,
      signal: dependencies.signal,
      onStep,
    };
    let runs: ExperimentRun[];
    if (isComparison) {
      runs = await compare(
        {
          ...settings,
          models,
          targets: targets as Language[],
          repetitions,
          onRunStart: (model, target, repetition) =>
            errorOutput(
              `Running ${model} -> ${target}, repetition ${repetition}/${repetitions}\n`,
            ),
        },
        findClient,
      );
    } else {
      const target = targets[0] as Language;
      output(`Model: ${models[0]}\nTarget: ${target}\nTranslation:\n> `);
      const result = await translate(findClient(models[0] ?? ""), {
        ...settings,
        targetLanguage: target,
        onStep,
      });
      output("\n");
      runs = [{ repetition: 1, result }];
    }
    for (const { repetition, result } of runs) {
      output(
        `${result.model} -> ${result.targetLanguage} [${result.status}, run ${repetition}] ${result.decisionCount} decisions, ${result.durationMs.toFixed(1)} ms, ${result.usage.totalTokens ?? "unknown"} reported tokens\n`,
      );
      if (isComparison) output(`${result.text || "(no output)"}\n`);
      if (result.error) errorOutput(`${result.error}\n`);
    }
    const summary = summarize(runs);
    if (isComparison)
      for (const row of summary)
        output(
          `${row.model} -> ${row.targetLanguage}: ${row.completed}/${row.runs} completed; mean ${row.meanDurationMs?.toFixed(1) ?? "unknown"} ms, ${row.meanDecisions?.toFixed(1) ?? "unknown"} decisions (completed runs)\n`,
        );
    if (outputPath) {
      const packageInfo = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      );
      const report = {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        runtime: {
          node: process.version,
          dependencies: packageInfo.dependencies,
        },
        settings: {
          source,
          sourceLanguage,
          models,
          targets,
          repetitions,
          maxChars,
          maxDecisions: maxDecisions ?? null,
          timeoutMs,
          maxRetries,
        },
        interrupted: dependencies.signal?.aborted ?? false,
        runs,
        summary,
      };
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
        flag: "wx",
      });
      output(`Saved report: ${outputPath}\n`);
    }
    if (dependencies.signal?.aborted) return 130;
    return runs.length > 0 &&
      runs.every((run) => run.result.status === "completed")
      ? 0
      : 1;
  } catch (error) {
    errorOutput(
      `Error: ${error instanceof Error ? error.message : "Experiment failed."}\n`,
    );
    return dependencies.signal?.aborted ? 130 : 1;
  }
}

async function main(): Promise<void> {
  try {
    const envPath = fileURLToPath(new URL("../.env", import.meta.url));
    if (existsSync(envPath)) process.loadEnvFile(envPath);
  } catch {
    process.stderr.write("Error: Could not read the local .env file.\n");
    process.exitCode = 1;
    return;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  try {
    process.exitCode = await runCli(process.argv.slice(2), {
      signal: controller.signal,
    });
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
