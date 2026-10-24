// Sends email through Resend's API or SMTP, whichever is configured.
// With neither, it logs a one-line note so nothing silently disappears.
import nodemailer from 'nodemailer';

export function createMailer(mail, { logger = console, fetchImpl = globalThis.fetch } = {}) {
  if (mail.resendApiKey && mail.from) {
    return {
      enabled: true,
      provider: 'resend',
      async send({ to, subject, text }) {
        if (!to) return;
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${mail.resendApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: mail.from, to: [to], subject, text }),
        });
        if (!res.ok) throw new Error(`Resend refused the email (${res.status}): ${(await res.text()).slice(0, 200)}`);
      },
    };
  }

  if (mail.host && mail.from) {
    const transport = nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      auth: mail.user ? { user: mail.user, pass: mail.pass } : undefined,
    });
    return {
      enabled: true,
      provider: 'smtp',
      async send({ to, subject, text }) {
        if (!to) return;
        await transport.sendMail({ from: mail.from, to, subject, text });
      },
    };
  }

  return {
    enabled: false,
    provider: 'none',
    async send({ to, subject }) {
      logger.warn(`[mail] email not configured; skipped "${subject}" to ${to}`);
    },
  };
}
