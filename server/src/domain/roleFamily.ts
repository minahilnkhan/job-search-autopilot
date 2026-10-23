// Cheap title screen for postings pulled from job boards. A company board
// lists every opening (accountants, recruiters, researchers); only engineering
// roles are worth an AI scoring call. This is deliberately loose: it removes
// obvious non-matches and leaves judging the borderline ones to the scorer.
// Jobs you paste yourself skip it, since you already chose them.

const ENGINEERING = /\b(engineer|engineering|developer|forward[- ]deployed|deployment strategist|swe)\b/i;
const NOT_A_FIT =
  /\b(manager|director|head of|recruit(er|ing)|hardware|mechanical|electrical|mechatronics|firmware|asic|fpga|rf|chip|silicon|research scientist|scientist|counsel|attorney)\b/i;

export function isTargetRole(title: string): boolean {
  return ENGINEERING.test(title) && !NOT_A_FIT.test(title);
}
