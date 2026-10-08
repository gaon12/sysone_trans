import { createOpenAI } from "@ai-sdk/openai";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { APICallError, experimental_decide as decide } from "ai";
import type { DecisionClient, ProviderId } from "./types.js";

export const DEFAULT_MODELS = [
  "typesafe:jev-latest",
  "openai:gpt-6-luna",
] as const;

export interface ClientSettings {
  apiKeys?: Partial<Record<ProviderId, string>>;
  environment?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
}

export function parseModelId(id: string): {
  provider: ProviderId;
  model: string;
} {
  const separator = id.indexOf(":");
  const provider = id.slice(0, separator);
  const model = id.slice(separator + 1);
  if (
    separator < 1 ||
    !model.trim() ||
    model !== model.trim() ||
    (provider !== "typesafe" && provider !== "openai")
  ) {
    throw new Error(
      "Use a model ID in the form typesafe:<model> or openai:<model>.",
    );
  }
  return { provider, model };
}

/** Create a direct provider instance with the user's own credentials. */
export function createDecisionClient(
  id: string,
  settings: ClientSettings = {},
): DecisionClient {
  const { provider, model } = parseModelId(id);
  const environment = settings.environment ?? process.env;
  const keyVariable =
    provider === "typesafe" ? "TYPESAFE_API_KEY" : "OPENAI_API_KEY";
  const apiKey = (
    settings.apiKeys?.[provider] ??
    environment[keyVariable] ??
    (provider === "typesafe" ? environment.TYPESAFE_AI_API_KEY : undefined)
  )?.trim();
  if (!apiKey) {
    throw new Error(
      `Set ${keyVariable} before using the ${provider} provider.`,
    );
  }
  const timeoutMs = settings.timeoutMs ?? 30_000;
  const maxRetries = settings.maxRetries ?? 2;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2 ** 32 - 1
  ) {
    throw new Error("timeoutMs must be a positive integer below 2^32.");
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error("maxRetries must be a nonnegative integer.");
  }

  // Explicit URLs and model instances prevent accidental Gateway/proxy routing.
  const decisionModel =
    provider === "typesafe"
      ? createTypeSafeAi({
          apiKey,
          baseURL: "https://api.typesafe.ai/v1",
          fetch: settings.fetch,
        }).decisionModel(model)
      : createOpenAI({
          apiKey,
          baseURL: "https://api.openai.com/v1",
          fetch: settings.fetch,
        }).decisionModel(model);

  return {
    id,
    async decide(input, signal) {
      if (
        input.options.length < 1 ||
        input.options.length > 255 ||
        new Set(input.options.map((option) => option.label)).size !==
          input.options.length
      ) {
        throw new Error("A decision needs 1–255 options with unique labels.");
      }
      const timeout = AbortSignal.timeout(timeoutMs);
      const abortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        abortSignal.throwIfAborted();
        const result = await decide({
          model: decisionModel,
          state: input.state,
          questions: {
            next_unit: {
              type: "choice",
              instructions: input.instructions,
              criteria: Object.fromEntries(
                input.options.map(({ label, description }) => [
                  label,
                  description,
                ]),
              ),
            },
          },
          maxRetries,
          abortSignal,
        });
        const metadata = result.providerMetadata?.[provider]?.confidence;
        const confidence =
          metadata && typeof metadata === "object" && "next_unit" in metadata
            ? metadata.next_unit
            : null;
        return {
          label: result.answers.next_unit.choice,
          probabilities: result.answers.next_unit.probabilities ?? null,
          confidence:
            typeof confidence === "number" && Number.isFinite(confidence)
              ? confidence
              : null,
          resolvedModel: result.response.modelId,
          usage: {
            inputTokens: result.usage.inputTokens ?? null,
            outputTokens: result.usage.outputTokens ?? null,
            totalTokens: result.usage.totalTokens ?? null,
          },
        };
      } catch (error) {
        // SDK errors can contain raw response bodies. Keep keys and inputs private.
        if (abortSignal.aborted) {
          throw new Error(
            signal?.aborted
              ? "Translation cancelled."
              : "Decision request timed out.",
          );
        }
        if (APICallError.isInstance(error)) {
          const status = error.statusCode ? ` (HTTP ${error.statusCode})` : "";
          throw new Error(`Decision request failed${status}.`);
        }
        throw new Error(
          "The provider returned an invalid or refused decision.",
        );
      }
    },
  };
}
