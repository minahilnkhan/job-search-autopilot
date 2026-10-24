# Design decisions

The non-obvious decisions, with the reasoning and what was rejected. Most entries are a few lines.

## Phase 1

### Hard filters are pure functions, not LLM calls
`runHardFilters(input) → { pass, reasons[] }` takes the posting's fields, the company's E-Verify status, and the application history as plain values. It touches no database, clock, network, or model.
- **Why:** eligibility rules (STEM OPT, experience, location) must be explainable and repeatable. The same posting has to get the same answer every time, and every rule has a unit test.
- **Rejected:** asking the LLM "does this job pass?" That's non-deterministic, hard to test, can't be audited, and costs money per job.

### Regex extraction prefills; the human confirms; filters run on confirmed fields
- **Why:** regexes miss some phrasings and match some boilerplate. Instead of chasing 100% accuracy, every field is editable, the verdict updates live, and the filters only see what you confirmed.
- **Rejected:** LLM extraction in Phase 1. That's an API dependency and a cost for something regex plus review handles. It can be revisited if review time turns out to be the bottleneck.

### Every rule runs; no short-circuit
A job that's too senior AND outside the US shows both reasons. That makes correcting a misread field quick, and the list doubles as an audit trail.

### Evidence for every verdict
Each extracted field stores the snippet it came from, with the exact matched words marked. A wrong match is obvious at a glance ("that 5 years was the company's age").

### Boilerplate is stripped before matching
EEO statements mention "citizenship" and "national origin" as things the employer *doesn't* discriminate on. Those sentences are removed before the citizenship and clearance patterns run. A real requirement in the same posting is still caught (there's a test for it).
- Sentences are split only after a lowercase letter or digit plus a period, so "U.S. citizen" stays one sentence.
- The E-Verify notice also lives in boilerplate, so it's read from the raw text.

### Fail vs. warn
- **Fail** (excluded): 4+ years required; Senior/Staff/Lead/Principal/Director/Head of/VP titles; non-US location; 1099, C2C, freelance, unpaid, or commission-only; clearance; US citizenship or US-person requirement (including ITAR); pure sales titles; already applied; 2+ applications at the company in 30 days.
- **Warn** (allowed, flagged to check): unknown E-Verify; contract or contract-to-hire; staffing/consulting firm; part-time (STEM OPT needs 20+ hours); missing years or location; remote with no country; "III" in the title; "no sponsorship".
- "No sponsorship" is a warning, not a fail. You can still work there on OPT; it just means a shorter runway, so Phase 2 caps those jobs at Tier B.

### Dedupe on insert: company + normalized title + normalized location
Normalization is deliberately conservative: case, punctuation, and "Sr." → "senior". "Software Engineer" and "Software Engineer II" stay separate. A duplicate paste returns the existing job (`{ duplicate: true }`) instead of an error.
"Already applied" matches on company + title in **any** location, which catches a role reposted in a new city.

### The 30-day company cap
It counts applications at `approved` or later, timed by `submitted_at` (or `approved_at` if not yet submitted). The window is inclusive. Drafts don't count, and neither does a job's own application when that job is re-checked.

### Company facts are filter inputs, so changing them re-checks jobs
Setting E-Verify to "confirmed" re-runs the filters on every job at that company.

### Fastify + zod + Drizzle + SQLite
- **SQLite:** one user, local-first, zero ops, and the whole DB is one file.
- **Drizzle over Prisma:** schema in TypeScript, SQL migrations committed to the repo and readable, no codegen step or engine binary, and synchronous better-sqlite3 calls keep the services simple.
- **zod at the HTTP boundary:** invalid input returns a 400 with field paths. The domain code trusts its types.
- `buildApp(db)` takes the DB as a parameter, so API tests run against an in-memory DB with `app.inject()`, no port needed.

### Schema additions beyond the spec
- `jobs.extracted_fields` (JSON): the reviewed fields plus evidence the filters ran on, so any verdict can be re-explained or re-run.
- `jobs.dedupe_key` with a unique index: dedupe enforced by the DB, not just app code.
- Unique index on `lower(companies.name)`: "Anthropic" and "anthropic" are one company.
- `jobs.filter_fail_reasons` holds fails **and** warnings, each tagged with `severity`.
- `settings` is a single row with one JSON column per group, validated by one zod schema.

### Safety and ToS
- The posting URL is stored as metadata and never fetched in Phase 1. Phase 2 fetches only from the public Greenhouse/Lever/Ashby job-board APIs. No LinkedIn scraping, ever.
- Work-authorization answers are fixed settings ("Authorized: Yes", "Sponsorship now or future: Yes"), never generated.
- The server binds to 127.0.0.1. It has no auth, so it must not be reachable from the network.
- `data/private/` (inventory, DO NOT CLAIM list, resumes) and `.env` are gitignored.

## Phase 2

### The AI judges; code counts
The model returns per-requirement judgments (met / partial / not, with the inventory fact as evidence), a role-signal score, a stack-match score with reasons, and red flags. Code turns those into the 1–10 total:
- **Requirements match (0–4)** = 4 × share met, with partial worth half. It's computed from the per-requirement list, so the number is auditable line by line.
- **A "met" with no evidence is downgraded to "partial".** This is the scoring-side half of the no-fabrication rule; Phase 3's Truth Check is the resume-side half.
- **Strategic bonus (0–2)** comes from company facts (tags, H-1B history, warm contact). They're facts in the database, so asking a model about them would only add a way to be wrong.
- Tiers, the "no sponsorship → B" cap, and stale-posting flags are code.
- **Rejected:** asking the model for the final score. It isn't reproducible, can't be explained, and drifts between runs.

### Hand-written JSON Schema, validated on return
Structured outputs (`output_config.format`) constrain the response. The SDK's zod helper turned the `met` enum into a description, which would leave it unconstrained, so the schema is written by hand and the response is validated with zod (case-insensitive enums, as the docs advise). Numeric ranges aren't allowed in the schema; the integer fields use `enum: [0, 1, 2]` and code clamps anyway. Refusals and `max_tokens` stops are errors, never parsed.

### Cost controls
- Haiku 5.5 for scoring ($0.10 / $0.50 per million tokens in/out). Sonnet is reserved for tailoring and check-ins.
- The mentor prompt plus inventory is one cached system prefix. The first call in a run writes the cache **alone**, then 4 calls run in parallel reading it, so they don't each pay to write it.
- Cheap filters run first: dedupe, hard filters, and the engineering-title screen happen before any paid call.
- A per-run cap (150 by default) bounds the worst case.
- Every call is logged in `api_usage` with tokens and computed cost; an unknown model's cost is `null`, never $0.
- Batch API (50% off) was considered and rejected for now: results can take hours, and at ~$0.001 a job the savings are cents.

### Job-board postings must be target roles; pasted jobs needn't be
A company board lists everything. The first live run fetched about 1,160 postings from 11 companies, and a loose "any engineering title" screen still let 336 through to scoring. The screen now matches the mentor prompt's target list: FDE, deployment, solutions, customer, implementation, applied AI and AI engineer titles, plus generalist, new-grad, full-stack and backend software titles. Specialty software titles outside that list (infrastructure, security, data, ML, mobile, SRE…) are excluded.
- Off-target postings are still stored, so they're never fetched and checked again, but they're hidden from the main Jobs list.
- Each run re-checks the unscored backlog against the current rules before scoring, so a rule change applies to jobs already in the database without anyone paying to score them.
- A job you paste yourself skips the screen: you already chose it.
- Postings older than 30 days aren't scored. The mentor prompt treats them as likely stale and they'd rank last anyway. A missing date is kept, since no date isn't evidence of staleness.

### The shortlist is a ranked snapshot per day
`shortlists` stores the ranked job IDs per date, so "what did it recommend on Tuesday" has an answer. Ranking: stale (30+ days) last, then score, then freshness (≤ 7 days), then Chicago/remote, then warm contact. The per-company 30-day cap is applied while picking. Size = daily target + 3, matching the mentor prompt's "2–3 more than the target".

### Scheduling: node-cron in the server, plus catch-up
It's a local app, so the job runs inside the server process. When the laptop is asleep at 7:00, the next start notices that no run completed today and runs once. Failed runs don't count as completed, so they retry on the next start. There's an in-process lock so two runs can't overlap. **Rejected:** OS-level cron or launchd. It's more setup on your machine, and it can't see the in-app lock.

### Public job-board APIs only
Greenhouse (`boards-api.greenhouse.io`), Lever (`api.lever.co/v0/postings`), and Ashby (`api.ashbyhq.com/posting-api`) publish these endpoints for exactly this use. One company at a time, with a 20-second timeout and an honest User-Agent. Each company records its last fetch result, so a broken board token is visible on the Companies page. Board tokens for the seed list were checked against live responses; 11 of 12 worked.

### Prompt injection
Job descriptions are untrusted text. They go inside `<job_posting>` tags with an instruction to treat them as data. Even if a posting fooled the model, the damage is limited: the model can't change the filters, the tier math, or anything outside its own judgment fields.

### Today's picks: a score floor and an age limit, not a different rubric
Picks default to **8+ fit and posted within 14 days**, both editable in Settings. Applying early to a strong match beats applying late to a long list. These are ranking thresholds: the scoring rubric (the mentor prompt) is unchanged, so a 7 still means the same thing; it just doesn't make the daily list. Changing a threshold re-ranks today's picks from existing scores, with no new AI calls.
Finding less competitive roles is mostly a sourcing question, not a scoring one. Famous AI labs get the most applicants for every posting, so the bigger lever is adding smaller companies in domains where the candidate's background is unusual.

### Chicago gets a ranking boost, not a scoring boost
A job in a preferred city (Settings → Location; Chicago) gets +1 ranking point by default (0–2 in Settings). A Chicago 7 clears an 8 minimum and ranks with the 8s, and a preferred-city job wins ties. Remote still breaks ties among the rest. The fit score and tier are untouched, so "8/10" always means the same thing, whatever the location.

### Company list: smaller companies in domains where the background is unusual
22 companies added, every job-board endpoint checked against a live response (2026-10-23): Chicago-based (Sprout Social, project44, FourKites, Civis Analytics, SpotHero, LogicGate), ed-tech and language learning (Coursera, Newsela, Khan Academy, Speak, MagicSchool), legal-tech (Everlaw), gov-tech (Nava, Code for America, Polimorphic), and AI startups with deployment or solutions teams (Writer, LangChain, Abridge, Cresta, Talkdesk, Stuut, Camunda). Candidates that failed verification (wrong or private board tokens) were left out rather than guessed.

## Phase 3

### The inventory is the source of truth; the DO NOT CLAIM list is derived from it
`candidate_inventory.md` is parsed at check time: numbers outside the DO NOT CLAIM section become the allowed set; each DO NOT CLAIM bullet becomes a rule (the numbers and quoted phrases in its first sentence); "X, Y and Z were designed by …" becomes an ownership rule. The derived rules are written to `do_not_claim.json` so you can see exactly what's enforced, and `do_not_claim.extra.json` holds patterns the parser can't infer. **Rejected:** a hand-kept `do_not_claim.json`. Two lists drift, and the one that drifts is the one that matters.

### Only the first sentence of a DO NOT CLAIM item is the claim
"60% search-latency cut, or 3s to 1.2s. Made up. Latency did improve…": the numbers after the first sentence are explanation, not forbidden claims.

### One issue per line, with the best-matching entry
"60%" appears in three DO NOT CLAIM entries. The check reports the one whose wording overlaps the line ("latency" → the latency entry) and says how many others matched, instead of listing the same line three times.

### Tailoring can reword and reorder, never add
The model sees the base resume with line ids and may only return `{id, after}` edits and bullet permutations. Code applies them, ignoring unknown ids and invalid reorders, so it can't invent a role or a project. Everything it writes goes through the Truth Check like anything else.

### Overrides are explicit, explained, and fragile on purpose
A Truth Check failure can be overridden only with a written reason (at least a sentence), and any later edit clears the override: you vouched for that text, not the new one. PDF problems (no PDF, or more than one page) can't be overridden, because there'd be nothing sound to submit.

### One structure, two renderers
The resume is a small plain-text format parsed into one structure, which feeds the PDF (HTML template printed by Chromium), the DOCX (`docx` library), the Truth Check and the diff. **Rejected:** DOCX template → PDF via LibreOffice: a large install on your Mac, and a separate path where the PDF could differ from what was checked.

### "Not applying" isn't an application
Rejecting in review sets status `withdrawn` with your reason and dismisses the job, and the 30-day company cap ignores withdrawn applications that were never submitted.

### Status transitions are a whitelist
`draft → ready_for_review → approved → submitted → …`. Every change goes through `assertTransition`, so nothing can jump from draft to submitted.

### Thinking budgets (fix after the first live runs)
Claude 5.5 models think before answering, and thinking counts toward `max_tokens`. Haiku 5.5 scoring at `max_tokens: 2000` ran out of room on 18 long postings (`stop_reason: max_tokens`). Scoring is a structured judgment against a written rubric, so it now runs with `thinking: disabled`, `effort: low` and 3,000 tokens, which is cheaper and can't truncate. Tailoring (Sonnet 5.5) benefits from thinking, so it keeps it, at `effort: medium` with 16,000 tokens of room; you only pay for tokens used. Jobs that failed stay unscored and are retried on the next run.

### After first use: a deck, not a list
Picks were "fit 8+ and posted within 14 days", which left one job some days. Now a fixed number per tier (5 A + 5 B by default); the city boost reorders within a tier but never moves a job into the other tier's slots. Accept/skip remove the card and the server re-ranks from the remaining `new` jobs (no AI calls), so the deck refills without a run. Undo exists for skip only: accept starts paid work, and "Not applying" in Review covers changing your mind.

### Citizenship is checked on the raw posting, with an EEO guard
"US citizen or green card holder" slipped through because the old patterns only knew "US citizen" and the EEO boilerplate was stripped before matching. Patterns now cover permanent residency, "US persons" with ITAR/EAR, and "citizenship required", matched on the raw text, skipping a match whose sentence is equal-opportunity language ("without regard to citizenship"). Every stored job-board posting is re-checked on startup and before each run, unless you confirmed its fields by hand.

### Accept runs in the background
Tier A tailoring takes 20–40 seconds, and the deck shouldn't wait on it. The server marks the job accepted, returns 202, and prepares it in the background; failures show on Today and Review with Try again / Put back in the deck. The in-progress list lives in memory: a restart mid-preparation loses it, and the job can be put back from the Jobs page. Chromium is now launched once and reused, which was most of the PDF time.

### One note writer, with a brief and a visible basis
Tier A notes used to come from the tailoring call as a side job, with a one-line instruction. Now every note comes from one writer (`llm/note.ts`) with a real brief: who she is in a line, one company value taken from the posting (or company notes) and shown through a specific inventory story without naming it, one memorable detail, soft skills shown by actions, and AI-first as a plain fact. The model also returns what it built the note around (value, the posting's words, story, standout), stored as `note_basis` and shown above the note, so you can judge it quickly and redraft if it picked the wrong angle. Still capped at 99 words by the Truth Check. That's tight for five ideas, so the brief asks for them woven into 3–4 sentences, not listed. Tailoring no longer writes a note, which saves output tokens.
