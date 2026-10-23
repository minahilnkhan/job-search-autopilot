import { config } from "../config";
import type { ScorerFactory } from "../services/pipeline";
import { loadMentorContext, MissingContextError } from "./context";
import { makeAnthropicScorer } from "./scoreJob";

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
