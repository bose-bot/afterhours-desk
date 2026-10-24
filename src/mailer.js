// Sends email over SMTP when configured; otherwise logs a one-line note so nothing silently disappears.
import nodemailer from 'nodemailer';

export function createMailer(mail, logger = console) {
  if (!mail.host || !mail.from) {
    return {
      enabled: false,
      async send({ to, subject }) {
        logger.warn(`[mail] SMTP not configured; skipped "${subject}" to ${to}`);
      },
    };
  }
  const transport = nodemailer.createTransport({
    host: mail.host,
    port: mail.port,
    secure: mail.secure,
    auth: mail.user ? { user: mail.user, pass: mail.pass } : undefined,
  });
  return {
    enabled: true,
    async send({ to, subject, text }) {
      if (!to) return;
      await transport.sendMail({ from: mail.from, to, subject, text });
    },
  };
}
