import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { TokenUsage } from "./pricing";
import { mentorSystem, type MentorContext } from "./context";
import { ScoreError } from "./scoreJob";

// The daily check-in and the Sunday weekly review.
//
// The model is never asked to restate a number. Every count, hour and rate in
// the output is rendered in code from <tracker_state>; the model is asked for
// the parts that need judgment: what to do today, what the week's numbers
// mean, what to build next. That's the hard rule ("base ALL counts on
// tracker_state") enforced the only way it can be: by not giving the model
// the job.

const str = { type: "string" } as const;

const bucket = { type: "string", enum: ["applications", "projects", "prep"] } as const;

const DAILY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["priorities", "verdict", "adjustments"],
  properties: {
    priorities: {
      type: "array",
      description: "Exactly 3, most important first. What she should do today, given the state.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "bucket", "estimateMinutes", "why"],
        properties: {
          title: { type: "string", description: "An action, specific enough to start: 'Apply to the 3 Tier A picks', not 'make progress'" },
          bucket,
          estimateMinutes: { type: "integer", description: "Realistic minutes, 15 to 240" },
          why: { type: "string", description: "One short clause tying it to the numbers" },
        },
      },
    },
    verdict: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "text"],
      properties: {
        kind: { type: "string", enum: ["win", "call_out", "none"], description: "A real win, a miss worth naming, or neither" },
        text: { type: "string", description: "One or two sentences. Specific, no guilt, no lecture. Empty when kind is none." },
      },
    },
    adjustments: { type: "array", description: "At most 2. A shift worth making, e.g. moving prep hours into applications. Empty when the plan stands.", items: str },
  },
} as const;

const dailySchema = z.object({
  priorities: z.array(z.object({ title: z.string(), bucket: z.enum(["applications", "projects", "prep"]), estimateMinutes: z.number().int(), why: z.string() })),
  verdict: z.object({ kind: z.enum(["win", "call_out", "none"]), text: z.string() }),
  adjustments: z.array(z.string()),
});

const DAILY_INSTRUCTIONS = `<task>
Write today's check-in for the candidate. Her real state is in <tracker_state>; <today_picks> lists the jobs the app shortlisted for her.

Do not restate counts, hours or rates: the app prints those itself. Give only:
1. priorities: exactly 3 things to do today, most important first, each with a realistic estimate. Work from the state: a full review queue means reviewing before sourcing more; a week behind on applications means applications before projects; an interview this week moves project hours into prep. Keep the day inside what's left of her weekly cap.
2. verdict: one win worth naming, or one miss worth naming, or none. Be specific and use her own numbers from the state ("3 screens from 40 applications"). Never guilt, never a lecture.
3. adjustments: at most two shifts worth making, said plainly. Empty if the plan stands.

Nothing here may invent facts about her background; the state and the inventory are all you know.
</task>`;

const WEEKLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["diagnosis", "targets", "projectIdeas", "prepFocus", "githubTask", "tasks"],
  properties: {
    diagnosis: { type: "string", description: "2 to 4 sentences on what last week's numbers say. If one role type is clearly converting after ~40+ applications, say to narrow. If nothing is converting, say whether it reads as the resume, the targeting or the volume." },
    targets: {
      type: "object",
      additionalProperties: false,
      required: ["applications", "projectHours", "prepHours", "note"],
      properties: {
        applications: { type: "integer", description: "Applications to aim for this week" },
        projectHours: { type: "number" },
        prepHours: { type: "number" },
        note: { type: "string", description: "One line: what changed from last week and why" },
      },
    },
    projectIdeas: {
      type: "array",
      description: "Exactly 6: five built around the skills in <skills_to_build>, then one wildcard that is fun and distinctive. One line each.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "oneLine", "skills", "wildcard"],
        properties: {
          title: str,
          oneLine: { type: "string", description: "What it does, the real API or messy data it uses, and the one result it would measure" },
          skills: { type: "array", items: str, description: "Which skills from the list it builds" },
          wildcard: { type: "boolean" },
        },
      },
    },
    prepFocus: { type: "string", description: "One line: what interview prep to spend the week's prep hours on" },
    githubTask: { type: "string", description: "One GitHub cleanup task for this week (pin repos, a README, remove secrets, archive dead repos)" },
    tasks: {
      type: "array",
      description: "The week's to-do list, 3 to 6 items, each inside the hours above",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "bucket", "estimateMinutes"],
        properties: { title: str, bucket, estimateMinutes: { type: "integer" } },
      },
    },
  },
} as const;

const weeklySchema = z.object({
  diagnosis: z.string(),
  targets: z.object({ applications: z.number().int(), projectHours: z.number(), prepHours: z.number(), note: z.string() }),
  projectIdeas: z.array(z.object({ title: z.string(), oneLine: z.string(), skills: z.array(z.string()), wildcard: z.boolean() })),
  prepFocus: z.string(),
  githubTask: z.string(),
  tasks: z.array(z.object({ title: z.string(), bucket: z.enum(["applications", "projects", "prep"]), estimateMinutes: z.number().int() })),
});

const WEEKLY_INSTRUCTIONS = `<task>
Write the Sunday weekly review. Her real state is in <tracker_state>, and the skills recent postings asked for that aren't on her resume are in <skills_to_build>.

Do not restate counts, hours or rates: the app prints those itself. Give only:
1. diagnosis: what last week's numbers mean.
2. targets for this week, inside the cap, with project hours past their bucket treated as approved overflow rather than a violation.
3. projectIdeas: six, as described in the schema. A project must integrate a real API or messy real data, solve a concrete user problem, be deployable, and carry one honest measured result. Not a tutorial clone; extending one of her existing projects is good.
4. prepFocus and githubTask: one line each.
5. tasks: the week's to-do list, in 1 to 2 hour pieces.

Nothing here may invent facts about her background; the state and the inventory are all you know.
</task>`;

export type DailyCheckIn = z.infer<typeof dailySchema>;
export type WeeklyReview = z.infer<typeof weeklySchema>;
export type CheckInInput = { trackerState: string; todayPicks: string; skillsToBuild: string };
export type CheckInWriter = {
  daily: (input: CheckInInput) => Promise<{ output: DailyCheckIn; usage: TokenUsage; model: string }>;
  weekly: (input: CheckInInput) => Promise<{ output: WeeklyReview; usage: TokenUsage; model: string }>;
};

export function makeAnthropicCheckIn(opts: { apiKey: string; model: string; context: MentorContext; fetch?: typeof fetch }): CheckInWriter {
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 3, fetch: opts.fetch });

  const call = async <T>(kind: "daily" | "weekly", input: CheckInInput, schemaJson: unknown, parser: z.ZodType<T>) => {
    const system = mentorSystem(
      opts.context,
      kind === "daily" ? DAILY_INSTRUCTIONS : WEEKLY_INSTRUCTIONS,
      kind === "daily" ? "checkin" : "weekly",
      { tracker_state: input.trackerState }
    );
    const msg = await client.messages.create({
      model: opts.model,
      max_tokens: kind === "daily" ? 6000 : 12000,
      system,
      messages: [
        {
          role: "user",
          content: [`<today_picks>\n${input.todayPicks || "(none shortlisted yet)"}\n</today_picks>`, `<skills_to_build>\n${input.skillsToBuild || "(none yet)"}\n</skills_to_build>`].join("\n\n"),
        },
      ],
      output_config: { effort: "medium", format: { type: "json_schema", schema: schemaJson as Record<string, unknown> } },
    });
    const usage: TokenUsage = {
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
    };
    if (msg.stop_reason !== "end_turn") throw new ScoreError(`The ${kind} check-in stopped early (${msg.stop_reason}).`, usage);
    const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ScoreError(`The ${kind} check-in returned text that isn't JSON.`, usage);
    }
    const parsed = parser.safeParse(raw);
    if (!parsed.success) throw new ScoreError(`The ${kind} check-in didn't match the schema: ${parsed.error.message}`, usage);
    return { output: parsed.data, usage, model: opts.model };
  };

  return {
    daily: (input) => call("daily", input, DAILY_SCHEMA, dailySchema),
    weekly: (input) => call("weekly", input, WEEKLY_SCHEMA, weeklySchema),
  };
}
