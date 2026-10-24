import type { ApplicationStatus } from "../../../shared/types";

// Allowed status changes. Anything not listed is refused, so an application
// can't jump from draft to submitted without passing review and approval.
const NEXT: Record<ApplicationStatus, ApplicationStatus[]> = {
  draft: ["ready_for_review", "withdrawn"],
  ready_for_review: ["approved", "draft", "withdrawn"],
  approved: ["submitted", "ready_for_review", "withdrawn"], // back to review = un-approve before submitting
  submitted: ["screen", "interview", "rejected", "ghosted", "withdrawn", "approved"], // approved = undo a mistaken "submitted"
  screen: ["interview", "offer", "rejected", "ghosted", "withdrawn"],
  interview: ["offer", "rejected", "ghosted", "withdrawn"],
  offer: ["withdrawn"],
  rejected: [],
  ghosted: ["screen", "interview", "rejected"], // a late reply
  withdrawn: [],
};

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return NEXT[from].includes(to);
}

export class TransitionError extends Error {}

export function assertTransition(from: ApplicationStatus, to: ApplicationStatus): void {
  if (!canTransition(from, to)) throw new TransitionError(`Can't move an application from "${from}" to "${to}".`);
}
