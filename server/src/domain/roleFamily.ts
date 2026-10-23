// Title screen for postings pulled from job boards, so only your target roles
// (job-mentor-prompt.md, "Target roles") reach an AI scoring call. A company
// board lists everything: accountants, recruiters, and engineering
// specialties outside your target list. Jobs you paste yourself skip this,
// since you already chose them.

// Named role families from the mentor prompt. Any of these is a target.
const TARGET_FAMILY = new RegExp(
  [
    "forward[- ]deployed",
    "deployment (engineer|strategist)",
    "solutions? engineer", // includes Technical Solutions Engineer
    "customer (success )?engineer",
    "implementation engineer",
    "integrations? engineer",
    "applied ai",
    "\\b(ai|llm|genai|gen ai) (engineer|developer)",
  ].join("|"),
  "i"
);

// General software titles count when they're generalist, early-career,
// full-stack, or backend: "Software Engineer", "Software Engineer, New Grad",
// "Full-Stack Engineer", "Backend Engineer", "Product Engineer".
const GENERAL_SWE = /\b(software (engineer|developer)|swe|full[- ]?stack|back[- ]?end (engineer|developer)|product engineer|web developer)\b/i;

// …but not when the title names a specialty outside the target list.
const OFF_TARGET_SPECIALTY =
  /\b(infrastructure|infra|security|data|machine learning|ml|ai research|research|site reliability|sre|devops|platform|kernel|compiler|distributed systems|storage|network(ing)?|embedded|firmware|hardware|robotics|graphics|game|test|qa|sdet|ios|android|mobile|frontend|front[- ]end|performance|reliability|systems|database|inference|training|gpu|cuda|identity|payments infrastructure)\b/i;

// Never a target, whatever else the title says.
const NOT_A_FIT =
  /\b(manager|director|head of|recruit(er|ing)|mechanical|electrical|mechatronics|asic|fpga|rf|chip|silicon|scientist|counsel|attorney)\b/i;

export function isTargetRole(title: string): boolean {
  if (NOT_A_FIT.test(title)) return false;
  if (TARGET_FAMILY.test(title)) return true;
  return GENERAL_SWE.test(title) && !OFF_TARGET_SPECIALTY.test(title);
}
