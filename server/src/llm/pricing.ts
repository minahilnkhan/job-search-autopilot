// USD per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing
// (checked 2026-10-23). Haiku 5.5 is priced higher above 100K prompt tokens;
// scoring prompts stay far below that, so only the standard tier is listed.
// Cache writes use the 5-minute TTL (1.25× input).
type Price = { input: number; cacheWrite: number; cacheRead: number; output: number };

export const PRICES: Record<string, Price> = {
  "claude-haiku-5-5": { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 },
  "claude-opus-5-5": { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

/** Null when the model isn't in the table, so an unknown price is never shown as $0. */
export function costUsd(model: string, u: TokenUsage): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return (
    (u.inputTokens * p.input +
      u.cacheWriteTokens * p.cacheWrite +
      u.cacheReadTokens * p.cacheRead +
      u.outputTokens * p.output) /
    1_000_000
  );
}
