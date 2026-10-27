import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { applications } from "../db/schema";
import { checkPairingCode, getPairingCode, newPairingCode } from "../services/extension";
import {
  answerAsk,
  extensionPayload,
  extensionQuestions,
  markSubmitted,
  matchApplications,
  saveExtensionReport,
  type SubmitDeps,
} from "../services/submissions";
import { getApplication, type PrepDeps } from "../services/applications";
import { applyChatEdits, proposeChat } from "../services/chat";

const idParam = z.object({ id: z.coerce.number().int().positive() });
const control = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(["text", "textarea", "select", "combobox", "radio", "checkbox", "file"]),
  label: z.string().max(2000),
  hints: z.string().max(2000),
  required: z.boolean(),
  value: z.string().max(10000),
  options: z.array(z.object({ id: z.string().optional(), text: z.string().max(500) })).max(300),
});
const filledList = z.array(z.object({ label: z.string().max(500), value: z.string().max(10000) })).max(300);

export function extensionRoutes(app: FastifyInstance, db: DB, deps: SubmitDeps | undefined, prep: PrepDeps) {
  // For the Settings page (same machine, not the extension): the code to paste into the extension.
  app.get("/api/extension-pairing", async () => ({ code: getPairingCode(db) }));
  app.post("/api/extension-pairing/new", async () => ({ code: newPairingCode(db) }));

  // Everything the extension calls needs the pairing code.
  app.register(
    async (scope) => {
      scope.addHook("onRequest", async (req, reply) => {
        if (!checkPairingCode(db, req.headers["x-autopilot-token"] as string | undefined)) {
          return reply.code(401).send({ error: "The extension isn't paired. Copy the pairing code from Settings in the app into the extension." });
        }
      });

      scope.get("/ping", async () => ({ ok: true }));

      scope.post("/match", async (req) => matchApplications(db, z.object({ url: z.string().max(4000) }).parse(req.body).url));

      scope.get("/applications/:id/payload", async (req) => extensionPayload(db, idParam.parse(req.params).id));

      scope.post("/applications/:id/questions", async (req) => {
        const { controls, url } = z.object({ controls: z.array(control).max(100), url: z.string().max(4000) }).parse(req.body);
        if (!deps) return { answers: [], asks: [] };
        return extensionQuestions(db, idParam.parse(req.params).id, deps, controls, url);
      });

      scope.post("/applications/:id/answer", async (req) => {
        const id = idParam.parse(req.params).id;
        const b = z.object({ askId: z.string(), answer: z.string().min(1).max(5000), remember: z.boolean().default(false), filled: z.boolean().default(false) }).parse(req.body);
        await answerAsk(db, id, b.askId, b.answer, b.remember, deps?.facts);
        // The extension typed it into the page itself.
        const report = getApplication(db, id).prefillReport;
        const ask = report?.asks?.find((a) => a.id === b.askId);
        if (report && ask) {
          ask.filled = b.filled;
          if (b.filled) report.filled = [...report.filled, { label: ask.label, value: b.answer.trim() }];
          db.update(applications).set({ prefillReport: report }).where(eq(applications.id, id)).run();
        }
        return { ok: true, ask };
      });

      scope.post("/applications/:id/report", async (req) => {
        const r = z
          .object({
            filled: filledList,
            leftForYou: z.array(z.object({ label: z.string().max(500), reason: z.string().max(500), required: z.boolean() })).max(300),
            resumeUploaded: z.boolean(),
            notices: z.array(z.string().max(1000)).max(20),
          })
          .parse(req.body);
        return saveExtensionReport(db, idParam.parse(req.params).id, r);
      });

      // Chat: propose edits (Truth-Checked), then apply the ones you accept.
      scope.post("/applications/:id/chat", async (req) => {
        const b = z
          .object({
            message: z.string().trim().min(1).max(4000),
            history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(8000) })).max(40).default([]),
            formQuestions: z.array(z.string().max(500)).max(100).default([]),
          })
          .parse(req.body);
        if (!deps) return { reply: "Chat isn't available in this setup.", edits: [], blocked: [] };
        return proposeChat(db, idParam.parse(req.params).id, deps, b);
      });
      scope.post("/applications/:id/chat/apply", async (req) => {
        const { edits } = z
          .object({ edits: z.array(z.object({ kind: z.enum(["line", "answer", "note"]), key: z.string().max(500), after: z.string().max(8000) })).min(1).max(30) })
          .parse(req.body);
        const r = await applyChatEdits(db, idParam.parse(req.params).id, prep, edits);
        return { status: r.application.status, resumeChanged: r.resumeChanged, message: r.message };
      });

      scope.post("/applications/:id/submitted", async (req) => markSubmitted(db, idParam.parse(req.params).id));
    },
    { prefix: "/api/extension" }
  );
}
