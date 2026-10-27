import { config } from "../config";
import type { ScorerFactory } from "../services/pipeline";
import { loadMentorContext, MissingContextError } from "./context";
import { makeAnthropicScorer } from "./scoreJob";
import { makeAnthropicTailor, type Tailor } from "./tailor";
import { makeAnthropicAnswerWriter, type AnswerWriter } from "./answers";
import { makeAnthropicChat, makeAnthropicFollowUp, type ChatWriter, type FollowUpWriter } from "./chat";
import type { Settings } from "../../../shared/types";

/** Real scorer, or a plain-words reason it can't run yet. */
export const anthropicScorerFactory: ScorerFactory = (settings) => {
  if (!config.anthropicApiKey) {
    return { unavailable: "no ANTHROPIC_API_KEY. Add it to .env in the repo folder and restart the app." };
  }
  try {
    const context = loadMentorContext();
    return { scorer: makeAnthropicScorer({ apiKey: config.anthropicApiKey, model: settings.models.scoring, context }) };
  } catch (err) {
    if (err instanceof MissingContextError) return { unavailable: err.message };
    throw err;
  }
};

/** Tailoring model (Sonnet by default), or why it can't run. */
export function anthropicTailorFactory(settings: Settings): { tailor: Tailor } | { unavailable: string } {
  if (!config.anthropicApiKey) return { unavailable: "no ANTHROPIC_API_KEY in .env" };
  try {
    const context = loadMentorContext();
    return { tailor: makeAnthropicTailor({ apiKey: config.anthropicApiKey, model: settings.models.tailoring, context }) };
  } catch (err) {
    if (err instanceof MissingContextError) return { unavailable: err.message };
    throw err;
  }
}

/** Answers unprepared form questions during assisted submit (tailoring model). */
export function anthropicAnswerFactory(settings: Settings): { writer: AnswerWriter } | { unavailable: string } {
  if (!config.anthropicApiKey) return { unavailable: "no ANTHROPIC_API_KEY in .env" };
  try {
    const context = loadMentorContext();
    return { writer: makeAnthropicAnswerWriter({ apiKey: config.anthropicApiKey, model: settings.models.tailoring, context }) };
  } catch (err) {
    if (err instanceof MissingContextError) return { unavailable: err.message };
    throw err;
  }
}

/** The extension's chat (tailoring model), or why it can't run. */
export function anthropicChatFactory(settings: Settings): { writer: ChatWriter } | { unavailable: string } {
  if (!config.anthropicApiKey) return { unavailable: "no ANTHROPIC_API_KEY in .env" };
  try {
    return { writer: makeAnthropicChat({ apiKey: config.anthropicApiKey, model: settings.models.tailoring, context: loadMentorContext() }) };
  } catch (err) {
    if (err instanceof MissingContextError) return { unavailable: err.message };
    throw err;
  }
}

/** Follow-up drafts for the Tracker (tailoring model), or why it can't run. */
export function anthropicFollowUpFactory(settings: Settings): { writer: FollowUpWriter } | { unavailable: string } {
  if (!config.anthropicApiKey) return { unavailable: "no ANTHROPIC_API_KEY in .env" };
  try {
    return { writer: makeAnthropicFollowUp({ apiKey: config.anthropicApiKey, model: settings.models.tailoring, context: loadMentorContext() }) };
  } catch (err) {
    if (err instanceof MissingContextError) return { unavailable: err.message };
    throw err;
  }
}
