import Anthropic from "@anthropic-ai/sdk";
import type { TokenUsage } from "./pricing";
import { fillMentorPrompt, type MentorContext } from "./context";
import { ScoreError } from "./scoreJob";

// Free-form mentor chat: mocks, "should I apply to this", "what do I say
// about the visa". Unlike every other call, this one gets the whole prompt,
// modules and all, because she could ask about any part of the search.
//
// It writes nothing. Resume and answer edits go through the application chat,
// where every change is Truth-Checked before she sees it.

export type MentorTurn = { role: "user" | "assistant"; text: string };
export type MentorChatInput = { trackerState: string; history: MentorTurn[]; message: string };
export type MentorChat = (input: MentorChatInput) => Promise<{ reply: string; usage: TokenUsage; model: string }>;

const INSTRUCTIONS = `<task>
You're talking with the candidate directly. Her current state is in <tracker_state>; the modules above are your standing rules.

Answer the question in front of you, in plain prose, as the mentor described above. Keep it short unless she asks for depth. Never restate her counts or hours unless she asks for them, and when you do, take them from <tracker_state>, never from memory. Never invent facts about her background: <candidate_inventory> is all you know, and the DO NOT CLAIM list is binding here too.

If she asks for a mock interview, ask one question and wait for her answer before the next. If she asks you to change her resume or an application, tell her to use the chat on that application, where the Truth Check runs on every edit.
</task>`;

export function makeAnthropicMentorChat(opts: { apiKey: string; model: string; context: MentorContext; fetch?: typeof fetch }): MentorChat {
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 3, fetch: opts.fetch });
  return async (input) => {
    const system: Anthropic.TextBlockParam[] = [
      {
        type: "text",
        text: fillMentorPrompt(opts.context.mentorPrompt, {
          candidate_inventory: opts.context.inventory,
          current_resume: null,
          tracker_state: input.trackerState,
          networking_summary: null,
        }),
      },
      { type: "text", text: INSTRUCTIONS, cache_control: { type: "ephemeral" } },
    ];
    const msg = await client.messages.create({
      model: opts.model,
      max_tokens: 4000,
      system,
      messages: [
        ...input.history.slice(-12).map((t) => ({ role: t.role, content: t.text })),
        { role: "user" as const, content: input.message },
      ],
      output_config: { effort: "low" },
    });
    const usage: TokenUsage = {
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
    };
    if (msg.stop_reason !== "end_turn" && msg.stop_reason !== "max_tokens") throw new ScoreError(`The mentor reply stopped early (${msg.stop_reason}).`, usage);
    const reply = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!reply) throw new ScoreError("The mentor returned an empty reply.", usage);
    return { reply, usage, model: opts.model };
  };
}
