import { useCallback, useEffect, useState } from "react";
import type { Job } from "../../shared/types";
import { api } from "./lib/api";
import { AddJob } from "./pages/AddJob";
import { Jobs } from "./pages/Jobs";
import { Companies } from "./pages/Companies";
import { Settings } from "./pages/Settings";

// Hash routing: four pages don't need a router dependency.
const ROUTES = [
  { path: "#/add", label: "Add a job" },
  { path: "#/jobs", label: "Jobs" },
  { path: "#/companies", label: "Companies" },
  { path: "#/settings", label: "Settings" },
] as const;
type Path = (typeof ROUTES)[number]["path"];

function useHashRoute(): Path {
  const read = () => (ROUTES.some((r) => r.path === location.hash) ? (location.hash as Path) : "#/add");
  const [route, setRoute] = useState<Path>(read);
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

export default function App() {
  const route = useHashRoute();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

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
    <div className="min-h-screen lg:grid lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="border-b border-line bg-surface lg:min-h-screen lg:border-r lg:border-b-0">
        <div className="px-4 pt-4 pb-2 lg:px-5 lg:pt-6 lg:pb-6">
          <p className="text-[17px] leading-tight font-bold">Job Search Autopilot</p>
          <p className="text-sm text-ink-soft">Nothing is sent without your approval.</p>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-col lg:px-3" aria-label="Main">
          {ROUTES.map((r) => (
            <a
              key={r.path}
              href={r.path}
              aria-current={route === r.path ? "page" : undefined}
              className={`shrink-0 rounded-md px-3 py-2 text-[15px] font-medium ${
                route === r.path ? "bg-paper text-ink" : "text-ink-soft hover:text-ink"
              }`}
            >
              {r.label}
              {r.path === "#/jobs" && jobs.length > 0 && <span className="ml-1.5 text-ink-soft">{jobs.length}</span>}
            </a>
          ))}
        </nav>
      </aside>

      <main className="px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
        {loadError && <p className="mb-6 rounded-md bg-fail-bg px-3 py-2 text-[15px] text-fail" role="alert">{loadError}</p>}
        {route === "#/add" && <AddJob onSaved={loadJobs} />}
        {route === "#/jobs" && <Jobs jobs={jobs} setJobs={setJobs} />}
        {route === "#/companies" && <Companies onJobsChanged={loadJobs} />}
        {route === "#/settings" && <Settings />}
      </main>
    </div>
  );
}
