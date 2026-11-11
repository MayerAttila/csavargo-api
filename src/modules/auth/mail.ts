import { createElement } from "react";
import { Html, Head, Preview, Body, Container, Heading, Text, Link } from "@react-email/components";
import { render } from "@react-email/render";
import nodemailer from "nodemailer";
import { Resend } from "resend";
import type { Config } from "../../lib/config.js";

export type AuthMail = { to: string; url: string; kind: "verification" | "reset" };
export type Mailer = (mail: AuthMail) => Promise<void>;

export function createMailer(config: Config): Mailer {
  const smtp = config.MAIL_PROVIDER === "smtp"
    ? nodemailer.createTransport({ host: config.SMTP_HOST, port: config.SMTP_PORT, secure: false,
      connectionTimeout: 5000, socketTimeout: 5000 }) : null;
  const resend = config.MAIL_PROVIDER === "resend" ? new Resend(config.RESEND_API_KEY) : null;
  return async ({ to, url, kind }) => {
    const subject = kind === "verification" ? "Erősítsd meg az e-mail-címedet" : "Csavargó – Új jelszó beállítása";
    const message = kind === "verification"
      ? "Az e-mail-címed megerősítéséhez kattints az alábbi hivatkozásra. A hivatkozás 24 óráig érvényes."
      : "Új jelszó beállításához kattints az alábbi hivatkozásra. A hivatkozás 1 óráig érvényes. Ha nem te kérted, hagyd figyelmen kívül ezt a levelet.";
    const html = await render(createElement(Html, { lang: "hu" },
      createElement(Head), createElement(Preview, null, subject),
      createElement(Body, null, createElement(Container, null,
        createElement(Heading, null, subject), createElement(Text, null, message),
        createElement(Link, { href: url }, kind === "verification" ? "E-mail-cím megerősítése" : "Új jelszó beállítása")))));
    const email = { from: config.MAIL_FROM, to, subject, html, text: `${subject}\n\n${message}\n\n${url}` };
    if (smtp) await smtp.sendMail(email);
    else if (resend) {
      const result = await resend.emails.send(email);
      if (result.error) throw new Error("Email delivery failed");
    }
  };
}
