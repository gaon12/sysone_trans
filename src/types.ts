import type { JSONValue } from "ai";

export type ProviderId = "typesafe" | "openai";
export type Language = "en" | "ja" | "ko";

export interface ChoiceOption {
  label: string;
  description: string;
}

export interface DecisionInput {
  state: Record<string, JSONValue>;
  instructions: string;
  options: readonly ChoiceOption[];
}

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface Decision {
  label: string;
  probabilities: Record<string, number> | null;
  // Provider confidence is kept separate from the selected option probability.
  confidence: number | null;
  resolvedModel: string;
  usage: TokenUsage;
}

export interface DecisionClient {
  readonly id: string;
  decide(input: DecisionInput, signal?: AbortSignal): Promise<Decision>;
}
