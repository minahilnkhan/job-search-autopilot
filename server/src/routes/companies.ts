import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { companies } from "../db/schema";
import { ConflictError, NotFoundError, refilterCompanyJobs } from "../services/jobs";
import { companyBody, idParam } from "./validation";

function isUniqueViolation(err: unknown) {
  return err instanceof Error && "code" in err && String(err.code).startsWith("SQLITE_CONSTRAINT_UNIQUE");
}

export function companyRoutes(app: FastifyInstance, db: DB) {
  app.get("/api/companies", async () => db.select().from(companies).orderBy(asc(companies.name)).all());

  app.post("/api/companies", async (req, reply) => {
    const body = companyBody.parse(req.body);
    try {
      const row = db.insert(companies).values(body).returning().get();
      reply.code(201);
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(`"${body.name}" already exists`);
      throw err;
    }
  });

  app.patch("/api/companies/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = companyBody.partial().parse(req.body);
    const before = db.select().from(companies).where(eq(companies.id, id)).get();
    if (!before) throw new NotFoundError(`Company ${id} not found`);
    try {
      db.update(companies).set(body).where(eq(companies.id, id)).run();
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(`"${body.name}" already exists`);
      throw err;
    }
    // E-Verify status is a filter input, so jobs at this company get re-checked.
    const refiltered = body.eVerify && body.eVerify !== before.eVerify ? refilterCompanyJobs(db, id) : 0;
    return { company: db.select().from(companies).where(eq(companies.id, id)).get(), refilteredJobs: refiltered };
  });
}
