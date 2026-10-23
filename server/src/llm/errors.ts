import Anthropic from "@anthropic-ai/sdk";

/**
 * Errors that will fail every call the same way (no credits, bad key, no
 * permission). Retrying the next job is pointless, so a run stops on these.
 */
export function accountProblem(err: unknown): string | null {
  if (!(err instanceof Anthropic.APIError)) return null;
  const msg = err.message ?? "";
  if (/credit balance|billing/i.test(msg)) {
    return "your Anthropic API account has no credits. Claude Pro doesn't include API usage; add credits at platform.claude.com/settings/billing, then press Run now.";
  }
  if (err.status === 401) return "the Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env, then restart the app.";
  if (err.status === 403) return "this API key doesn't have permission to use the API. Check the key's workspace in the Claude Console.";
  return null;
}
