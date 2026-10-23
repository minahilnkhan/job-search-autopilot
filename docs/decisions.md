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
