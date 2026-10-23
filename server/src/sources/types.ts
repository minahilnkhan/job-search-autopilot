/** One posting from a job board, normalized across Greenhouse, Lever and Ashby. */
export type NormalizedPosting = {
  externalId: string;
  title: string;
  location: string | null; // multiple locations joined with " | "
  remote: boolean;
  url: string;
  postedAt: string | null; // YYYY-MM-DD
  description: string; // plain text
  /** The board's own employment type when it has one ("Full-time", "Contract"…). */
  employmentType: string | null;
};

export type BoardRef = { atsType: "greenhouse" | "lever" | "ashby"; token: string };

export type FetchBoard = (board: BoardRef) => Promise<NormalizedPosting[]>;
