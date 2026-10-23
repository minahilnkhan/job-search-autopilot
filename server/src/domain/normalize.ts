// Normalization for dedupe. Deliberately conservative: it only folds
// differences that clearly mean the same thing (case, punctuation, "Sr."),
// so two genuinely different roles never collapse into one.

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bsr\b\.?/g, "senior")
    .replace(/\bjr\b\.?/g, "junior")
    .replace(/\beng\b\.?/g, "engineer")
    .replace(/[^a-z0-9+#]+/g, " ") // drop punctuation like "-", "/", "(", ")"
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeLocation(location: string | null | undefined): string {
  if (!location) return "";
  return location
    .toLowerCase()
    .replace(/\bunited states( of america)?\b|\busa\b|\bu\.s\.a?\.?/g, "us")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCompany(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Same company + title + location = same job (spec §2). */
export function dedupeKey(company: string, title: string, location?: string | null): string {
  return [normalizeCompany(company), normalizeTitle(title), normalizeLocation(location)].join("|");
}
