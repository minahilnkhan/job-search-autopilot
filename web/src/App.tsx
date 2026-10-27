import { useCallback, useEffect, useState } from "react";
import type { JobListItem } from "../../shared/types";
import { api, usd } from "./lib/api";
import { AddJob } from "./pages/AddJob";
import { Today } from "./pages/Today";
import { Jobs } from "./pages/Jobs";
import { Companies } from "./pages/Companies";
import { Settings } from "./pages/Settings";
import { Review } from "./pages/Review";
import { Resumes } from "./pages/Resumes";
import { Applications } from "./pages/Applications";

// Hash routing: a handful of pages don't need a router dependency.
// Four places in the nav; everything else hangs off one of them.
const NAV = [
  { path: "#/today", label: "Today" },
  { path: "#/applications", label: "Applications" },
  { path: "#/jobs", label: "Jobs" },
  { path: "#/settings", label: "Settings" },
] as const;
const PAGES = ["#/today", "#/applications", "#/review", "#/jobs", "#/add", "#/settings", "#/settings/resumes", "#/settings/companies"] as const;
type Page = (typeof PAGES)[number];
// Old addresses still work.
const MOVED: Record<string, string> = { "#/tracker": "#/applications?stage=submitted", "#/resumes": "#/settings/resumes", "#/companies": "#/settings/companies" };
const SECTION: Record<Page, string> = {
  "#/today": "#/today",
  "#/applications": "#/applications",
  "#/review": "#/applications",
  "#/jobs": "#/jobs",
  "#/add": "#/jobs",
  "#/settings": "#/settings",
  "#/settings/resumes": "#/settings",
  "#/settings/companies": "#/settings",
};

function useHashRoute(): Page {
  const read = (): Page => {
    const base = location.hash.split("?")[0]!;
    if (MOVED[base]) {
      history.replaceState(null, "", MOVED[base]);
      return read();
    }
    return (PAGES as readonly string[]).includes(base) ? (base as Page) : "#/today";
  };
  const [route, setRoute] = useState<Page>(read);
  useEffect(() => {
    const onHash = () => {
      setRoute(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

const SETTINGS_TABS = [
  { path: "#/settings", label: "General" },
  { path: "#/settings/resumes", label: "Resumes" },
  { path: "#/settings/companies", label: "Companies" },
] as const;

export default function App() {
  const route = useHashRoute();
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(0);
  const [spend, setSpend] = useState<number | null>(null);
  const loadCounts = useCallback(() => {
    api.summary().then((s) => setWaiting(s.review + s.blocked)).catch(() => {});
  }, []);
  useEffect(loadCounts, [loadCounts, route]);
  useEffect(() => {
    api.monthSpend().then((m) => setSpend(m.costUsd)).catch(() => {});
  }, [route]);

  const loadJobs = useCallback(() => {
    api
      .listJobs()
      .then((j) => {
        setJobs(j);
        setLoadError(null);
      })
      .catch(() => setLoadError("Can't reach the server. Start it with npm run dev, then reload."));
  }, []);
  useEffect(loadJobs, [loadJobs]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex min-h-16 max-w-[1120px] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-8">
          <a href="#/today" className="flex items-center gap-2.5">
            <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>
            </span>
            <span className="text-base font-semibold text-ink">Autopilot</span>
          </a>
          <nav className="flex flex-wrap gap-1" aria-label="Main">
            {NAV.map((n) => {
              const current = SECTION[route] === n.path;
              return (
                <a key={n.path} href={n.path} aria-current={current ? "page" : undefined}
                  className={`rounded-full px-3.5 py-2 text-sm ${current ? "bg-accent-bg font-semibold text-accent-ink" : "font-medium text-ink-soft hover:text-ink"}`}>
                  {n.label}
                  {n.path === "#/applications" && waiting > 0 && <span className="ml-1.5 rounded-full bg-accent px-1.5 text-xs text-white">{waiting}</span>}
                </a>
              );
            })}
          </nav>
          <span className="text-[13px] text-muted">{spend !== null ? `${usd(spend)} AI spend this month` : ""}</span>
        </div>
      </header>

      <main className="mx-auto max-w-[1120px] px-4 pt-10 pb-16 sm:px-8">
        {loadError && <p className="mb-6 rounded-xl bg-fail-bg px-4 py-3 text-fail" role="alert">{loadError}</p>}
        {SECTION[route] === "#/settings" && (
          <nav className="mb-6 flex flex-wrap gap-2" aria-label="Settings sections">
            {SETTINGS_TABS.map((t) => (
              <a key={t.path} href={t.path} aria-current={route === t.path ? "page" : undefined}
                className={`rounded-full px-4 py-2 text-sm ${route === t.path ? "bg-dark font-semibold text-white" : "border border-line bg-surface font-medium text-ink"}`}>
                {t.label}
              </a>
            ))}
          </nav>
        )}
        {route === "#/today" && <Today onJobsChanged={loadJobs} />}
        {route === "#/applications" && <Applications key={location.hash} onCountsChanged={loadCounts} />}
        {route === "#/review" && <Review key={location.hash.replace(/&?stage=[a-z]+/, "")} onCountsChanged={loadCounts} />}
        {route === "#/jobs" && <Jobs jobs={jobs} setJobs={setJobs} />}
        {route === "#/add" && <AddJob onSaved={loadJobs} />}
        {route === "#/settings" && <Settings />}
        {route === "#/settings/resumes" && <Resumes />}
        {route === "#/settings/companies" && <Companies onJobsChanged={loadJobs} />}
      </main>
    </div>
  );
}
