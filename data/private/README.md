# data/private

Gitignored except for this README and `*.example*` files. Personal data lives here:

- `job-mentor-prompt.md` (Phase 2): the mentor agent's system prompt. Scoring uses its rubric.
- `candidate_inventory.md`: verified facts about you plus a DO NOT CLAIM list. Start from `candidate_inventory.example.md`.
- `do_not_claim.json` (Phase 3): the DO NOT CLAIM list as structured data, which the Truth Check reads.
- Base resumes (Phase 3).

Nothing in this folder is ever committed or sent anywhere except, from Phase 2 on, to the Anthropic API as prompt context.
