import { config } from "../config";
import type { ScorerFactory } from "../services/pipeline";
import { loadMentorContext, MissingContextError } from "./context";
import { makeAnthropicScorer } from "./scoreJob";
import { makeAnthropicTailor, type Tailor } from "./tailor";
import { makeAnthropicNoteWriter, type NoteWriter } from "./note";
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

/** Recruiter-note writer (uses the tailoring model at low effort), or why it can't run. */
export function anthropicNoteFactory(settings: Settings): { writer: NoteWriter } | { unavailable: string } {
  if (!config.anthropicApiKey) return { unavailable: "no ANTHROPIC_API_KEY in .env" };
  try {
    const context = loadMentorContext();
    return { writer: makeAnthropicNoteWriter({ apiKey: config.anthropicApiKey, model: settings.models.tailoring, context }) };
  } catch (err) {
    if (err instanceof MissingContextError) return { unavailable: err.message };
    throw err;
  }
}
