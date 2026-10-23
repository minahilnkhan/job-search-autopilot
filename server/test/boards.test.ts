import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { boardUrl, parseAshby, parseGreenhouse, parseLever } from "../src/sources/boards";

// Fixtures follow the live response shapes checked on 2026-10-23, trimmed.
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8"));

describe("Greenhouse", () => {
  const [fde, ae] = parseGreenhouse(fixture("greenhouse.json"));

  it("normalizes fields and decodes the double-escaped HTML", () => {
    expect(fde).toMatchObject({
      externalId: "4012345",
      title: "Forward Deployed Engineer",
      location: "San Francisco, CA | New York City, NY",
      remote: false,
      postedAt: "2026-10-19",
      url: "https://job-boards.greenhouse.io/acme/jobs/4012345",
    });
    expect(fde!.description).toContain("2+ years of software engineering experience");
    expect(fde!.description).toContain("Python & TypeScript");
    expect(fde!.description).not.toMatch(/&lt;|<li>|&amp;/);
  });

  it("marks remote from the location", () => {
    expect(ae!.remote).toBe(true);
  });
});

describe("Lever", () => {
  const [newGrad, contract] = parseLever(fixture("lever.json"));

  it("joins description, lists and additional text; reads remote and commitment", () => {
    expect(newGrad).toMatchObject({
      externalId: "a1b2c3",
      title: "Software Engineer, New Grad",
      location: "Remote - United States | Chicago, IL",
      remote: true,
      employmentType: "Full-time",
      url: "https://jobs.lever.co/acme/a1b2c3",
    });
    expect(newGrad!.description).toContain("0-2 years of experience");
    expect(newGrad!.description).toContain("E-Verify");
    expect(newGrad!.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("keeps the board's commitment so contract roles get flagged", () => {
    expect(contract!.employmentType).toBe("Contract");
  });
});

describe("Ashby", () => {
  const postings = parseAshby(fixture("ashby.json"));

  it("skips unlisted postings, trims titles, merges secondary locations", () => {
    expect(postings).toHaveLength(1);
    expect(postings[0]).toMatchObject({
      title: "Solutions Engineer",
      location: "New York, NY (HQ) | Chicago, IL",
      employmentType: "Full-time",
      postedAt: "2026-10-15",
      remote: false,
    });
  });
});

it("builds the documented public endpoints", () => {
  expect(boardUrl({ atsType: "greenhouse", token: "anthropic" })).toBe("https://boards-api.greenhouse.io/v1/boards/anthropic/jobs?content=true");
  expect(boardUrl({ atsType: "lever", token: "palantir" })).toBe("https://api.lever.co/v0/postings/palantir?mode=json");
  expect(boardUrl({ atsType: "ashby", token: "ramp" })).toBe("https://api.ashbyhq.com/posting-api/job-board/ramp");
});
