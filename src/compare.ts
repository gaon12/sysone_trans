import {
  type TranslationResult,
  type TranslationSettings,
  translate,
  validateTranslationSettings,
} from "./translate.js";
import type { DecisionClient, Language } from "./types.js";

export interface ComparisonSettings
  extends Omit<TranslationSettings, "targetLanguage"> {
  models: readonly string[];
  targets: readonly Language[];
  repetitions?: number;
  onRunStart?: (model: string, target: Language, repetition: number) => void;
}

export interface ExperimentRun {
  repetition: number;
  result: TranslationResult;
}

export interface ComparisonSummary {
  model: string;
  targetLanguage: Language;
  runs: number;
  completed: number;
  completionRate: number;
  meanDurationMs: number | null;
  meanDecisions: number | null;
  meanOutputCharacters: number | null;
}

export function summarize(runs: readonly ExperimentRun[]): ComparisonSummary[] {
  const groups = new Map<string, ExperimentRun[]>();
  for (const run of runs) {
    const key = `${run.result.model}\u0000${run.result.targetLanguage}`;
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }
  return Array.from(groups.values(), (group) => {
    const first = group[0];
    if (!first) throw new Error("Empty comparison group.");
    const completed = group.filter((run) => run.result.status === "completed");
    const mean = (value: (result: TranslationResult) => number) =>
      completed.length
        ? completed.reduce((sum, run) => sum + value(run.result), 0) /
          completed.length
        : null;
    return {
      model: first.result.model,
      targetLanguage: first.result.targetLanguage,
      runs: group.length,
      completed: completed.length,
      completionRate: completed.length / group.length,
      meanDurationMs: mean((result) => result.durationMs),
      meanDecisions: mean((result) => result.decisionCount),
      meanOutputCharacters: mean((result) => result.outputCharacters),
    };
  });
}

/** Run a repeatable matrix, rotating model order to reduce fixed ordering effects. */
export async function compare(
  settings: ComparisonSettings,
  createClient: (id: string) => DecisionClient,
): Promise<ExperimentRun[]> {
  const repetitions = settings.repetitions ?? 1;
  if (!Number.isSafeInteger(repetitions) || repetitions < 1)
    throw new Error("Repetitions must be a positive integer.");
  if (!settings.models.length || !settings.targets.length)
    throw new Error("Select at least one model and target language.");
  if (
    new Set(settings.models).size !== settings.models.length ||
    new Set(settings.targets).size !== settings.targets.length
  ) {
    throw new Error("Models and target languages must not contain duplicates.");
  }
  // Resolve all requested credentials before any potentially billable decision.
  for (const targetLanguage of settings.targets)
    validateTranslationSettings({ ...settings, targetLanguage });
  const clients = settings.models.map(createClient);
  const runs: ExperimentRun[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    const offset = (repetition - 1) % clients.length;
    const ordered = [...clients.slice(offset), ...clients.slice(0, offset)];
    for (const targetLanguage of settings.targets) {
      for (const client of ordered) {
        if (settings.signal?.aborted) return runs;
        settings.onRunStart?.(client.id, targetLanguage, repetition);
        const result = await translate(client, { ...settings, targetLanguage });
        runs.push({ repetition, result });
        if (result.status === "cancelled") return runs;
      }
    }
  }
  return runs;
}
