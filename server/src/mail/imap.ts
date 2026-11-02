import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Envelope, MailMessage } from "../domain/mailMatch";

// The job-search inbox, read over IMAP with an app password.
//
// Read-only on purpose: the mailbox is opened with EXAMINE (readOnly), so the
// app can't mark mail as read, move it, delete it or send anything. It lists
// the envelopes (sender, subject, date) of mail since the last check, and
// downloads the body only of the ones `wanted` picks out. The rest of the
// inbox is never downloaded.

export type MailSource = (since: Date, wanted: (env: Envelope) => boolean) => Promise<{ scanned: number; messages: MailMessage[] }>;

/** `port`/`secure` default to Gmail's (993, TLS); they exist so a local test server can stand in. */
export function imapSource(opts: { host: string; user: string; password: string; port?: number; secure?: boolean }): MailSource {
  return async (since, wanted) => {
    const client = new ImapFlow({
      host: opts.host,
      port: opts.port ?? 993,
      secure: opts.secure ?? true,
      auth: { user: opts.user, pass: opts.password },
      logger: false,
    });
    try {
      await client.connect();
    } catch (err) {
      client.close(); // don't leave the socket open after a failed sign-in
      const e = err as { authenticationFailed?: boolean; responseText?: string; message: string };
      if (e.authenticationFailed) throw new Error("Gmail refused the sign-in. Check MAIL_ADDRESS and MAIL_APP_PASSWORD in .env (an app password, not your Google password).");
      throw new Error(`Couldn't reach ${opts.host}: ${e.responseText ?? e.message}`);
    }
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const uids = (await client.search({ since }, { uid: true })) || [];
      const picked: { uid: number; env: Envelope }[] = [];
      if (uids.length) {
        for await (const m of client.fetch(uids, { uid: true, envelope: true, internalDate: true }, { uid: true })) {
          const e = m.envelope;
          const from = e?.from?.[0];
          const env: Envelope = {
            messageId: e?.messageId ?? `uid-${m.uid}@inbox`,
            fromAddress: from?.address ?? "",
            fromName: from?.name || null,
            subject: e?.subject ?? "",
            date: e?.date ?? (m.internalDate instanceof Date ? m.internalDate : new Date()),
          };
          if (env.date >= since && wanted(env)) picked.push({ uid: m.uid, env });
        }
      }
      const messages: MailMessage[] = [];
      for (const p of picked) {
        const full = await client.fetchOne(String(p.uid), { source: true }, { uid: true });
        if (!full || !full.source) continue;
        const parsed = await simpleParser(full.source);
        const text = (parsed.text || (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : "")).slice(0, 20_000);
        messages.push({ ...p.env, text });
      }
      return { scanned: uids.length, messages };
    } finally {
      lock.release();
      await client.logout().catch(() => {});
    }
  };
}
