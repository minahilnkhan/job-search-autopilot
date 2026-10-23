import { z } from "zod";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const employmentFlagsSchema = z.object({
  w1099: z.boolean(),
  c2c: z.boolean(),
  freelance: z.boolean(),
  unpaid: z.boolean(),
  commissionOnly: z.boolean(),
  contract: z.boolean(),
  contractToHire: z.boolean(),
  staffingAgency: z.boolean(),
  partTime: z.boolean(),
});

export const extractedFieldsSchema = z.object({
  yearsRequired: z.number().int().min(0).max(30).nullable(),
  remote: z.boolean(),
  remoteCountryStated: z.boolean(),
  sponsorshipStated: z.enum(["yes", "no", "unstated"]),
  employment: employmentFlagsSchema,
  requiresClearance: z.boolean(),
  requiresCitizenship: z.boolean(),
  eVerifyMentioned: z.boolean(),
  evidence: z.record(z.string(), z.string()),
});

export const extractBody = z.object({
  title: z.string().trim().min(1),
  location: z.string().optional(),
  description: z.string().trim().min(20, "Paste the full job description"),
});

export const previewBody = z.object({
  companyName: z.string().trim().min(1),
  title: z.string().trim().min(1),
  location: z.string().optional(),
  fields: extractedFieldsSchema,
});

export const createJobBody = z.object({
  companyName: z.string().trim().min(1),
  title: z.string().trim().min(1),
  url: z.union([z.url(), z.literal("")]).optional(),
  location: z.string().optional(),
  postedAt: z.union([ymd, z.literal("")]).optional(),
  description: z.string().trim().min(20, "Paste the full job description"),
  fields: extractedFieldsSchema.optional(),
});

export const patchJobBody = z
  .object({
    title: z.string().trim().min(1),
    location: z.string().nullable(),
    url: z.union([z.url(), z.literal("")]).nullable(),
    postedAt: z.union([ymd, z.literal("")]).nullable(),
    fields: extractedFieldsSchema,
    status: z.enum(["new", "shortlisted", "dismissed"]),
  })
  .partial();

export const companyBody = z.object({
  name: z.string().trim().min(1),
  website: z.string().trim().nullable().optional(),
  atsType: z.enum(["greenhouse", "lever", "ashby", "other"]).nullable().optional(),
  atsBoardToken: z.string().trim().nullable().optional(),
  eVerify: z.enum(["confirmed", "likely", "unknown"]).optional(),
  h1bHistory: z.number().int().min(0).nullable().optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  warmContact: z.boolean().optional(),
  notes: z.string().nullable().optional(),
});

export const settingsBody = z.object({
  targets: z.object({
    appsPerDay: z.number().int().min(1).max(50),
    daysPerWeek: z.number().int().min(1).max(7),
    hoursPerWeekCap: z.number().min(1).max(80),
    bucketHours: z.object({
      applications: z.number().min(0),
      projects: z.number().min(0),
      prep: z.number().min(0),
    }),
  }),
  capReviewDate: ymd,
  workAuth: z.object({
    authorizedToWorkInUS: z.enum(["Yes", "No"]),
    requiresSponsorshipNowOrFuture: z.enum(["Yes", "No"]),
  }),
  locationPrefs: z.object({
    preferred: z.array(z.string().trim().min(1)),
    openToRelocation: z.boolean(),
  }),
  models: z.object({
    scoring: z.string().trim().min(1),
    tailoring: z.string().trim().min(1),
    checkIns: z.string().trim().min(1),
  }),
  shortlist: z.object({
    minFitScore: z.number().int().min(1).max(10),
    maxAgeDays: z.number().int().min(1).max(90),
    preferredCityBoost: z.number().int().min(0).max(2),
  }),
  pipeline: z.object({
    enabled: z.boolean(),
    dailyTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM"),
    timezone: z.string().refine((tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "Unknown timezone (use a name like America/Chicago)"),
    maxScoresPerRun: z.number().int().min(0).max(1000),
  }),
}).refine(
  (s) => s.targets.bucketHours.applications + s.targets.bucketHours.projects + s.targets.bucketHours.prep <= s.targets.hoursPerWeekCap,
  { message: "Bucket hours add up to more than the weekly cap", path: ["targets", "bucketHours"] }
);

export const idParam = z.object({ id: z.coerce.number().int().positive() });
