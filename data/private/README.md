# data/private

Gitignored except for this README and `*.example*` files. Personal data lives here:

- `job-mentor-prompt.md`: the mentor agent's system prompt (v2: shared rules plus `# MODULE:` sections; scoring gets MODULE: SCORING, tailoring/notes/answers/chat get MODULE: RESUME / TAILOR).
- `confirmed_additions.md`: created by the app when you confirm an assumption question. Counts as inventory for the Truth Check and every prompt.
- `candidate_inventory.md`: verified facts about you plus a DO NOT CLAIM list. Start from `candidate_inventory.example.md`.
- `do_not_claim.json` (Phase 3, generated): the DO NOT CLAIM list as structured data, rebuilt from the inventory on every check so you can see exactly what's enforced. Don't edit it.
- `do_not_claim.extra.json` (optional): extra phrases to block that the inventory parser can't infer, e.g. `{ "phrases": [{ "pattern": "eval harness", "claim": "A formal eval harness." }] }`.
- `resume_fde.md`, `resume_swe.md` (Phase 3): your base resumes, imported on first start. After that, edit them on the Resumes page.

Nothing in this folder is ever committed or sent anywhere except, from Phase 2 on, to the Anthropic API as prompt context.
