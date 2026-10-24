# Tailoring notes

How each Tier A resume is tailored. A condensed version of this is the tailoring prompt (`server/src/llm/tailor.ts`); the Truth Check (`server/src/domain/truthCheck.ts`) enforces the numbers rule in code.

Numbers come only from `candidate_inventory.md`, and never from its DO NOT CLAIM list. Exaggerated metrics are not allowed, however believable: interviewers dig into every bullet. To use a new number, add it to the inventory once it's true.

## Per role

1. Pull every keyword from the posting: title, required skills, preferred skills, responsibilities, tools, soft skills, domain language, and industry terms. Mark each as must-have or good-to-have. Spell out abbreviations once and also keep the short form (Amazon Web Services and AWS).
2. Match each keyword against the base resume and the longer notes (Yabla, iD Tech, the chemistry game, teaching assistant, writing associate, Bookmark, DeShare, and the other projects).
   - Already there: rewrite the bullet so the keyword and the impact are obvious, and place it higher.
   - Present but weak: strengthen it with a result you already have, and move it up.
   - Missing, but a real similar experience exists in the notes: add one truthful sentence in the posting's language.
   - Not supported by the notes: leave it out.
3. Rebuild the page around that match.
   - Summary under 50 words. Start with the role noun from the posting (Software Engineer, Backend Engineer, Technical Writer). Answer why you fit this job, in active voice, using that posting's keywords.
   - Headline under 10 words, used as the summary title when it reads cleanly. Otherwise keep a plain "Professional Overview" heading so an ATS can parse it.
   - Work experience stays reverse-chronological. Inside Yabla, put the bullets that match this job first. Swap in a project, the chemistry app, the teaching assistant role, or the writing associate role only when it covers a must-have the current page does not. (The app suggests these swaps in Review; you make them on the Resumes page.)
   - Skills: list the posting's tools you actually use, in the order the posting cares about them. Repeat the same terms inside experience and projects. Frequency should follow importance. A human still has to be able to read it.
4. Write each bullet as action, scope, and result: what you built, with which technology, and the measurable outcome already in your notes. One page. A few strong bullets beat a long list of average ones.
5. Keep the file ATS-plain: standard headings, no icons, tables, images, headers, footers, or symbols in headings. Contact line uses `|`. Dates stay as month and year. The app renders Arial 10.5 pt on 0.5 inch margins, with selectable PDF text.

## What does not change between roles

Name, phone, personal email, Chicago, LinkedIn, and GitHub stay. Dates and employers stay accurate. Yabla remains the lead role. iD Tech stays one combined entry for both summers, including the Roblox headquarters camp, unless the posting is specifically about teaching or program leadership. Metrics stay the ones in the inventory. Do not add a new number to chase a keyword.
