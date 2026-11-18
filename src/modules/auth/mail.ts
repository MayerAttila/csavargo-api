import { createElement } from "react";
import { render } from "@react-email/render";
import nodemailer from "nodemailer";
import { Resend } from "resend";
import type { Config } from "../../lib/config.js";
import CompanionInvite, { companionInviteSubject } from "../../emails/companion-invite.js";
import PasswordReset, { passwordResetSubject } from "../../emails/password-reset.js";
import VerifyEmail, { verifyEmailSubject } from "../../emails/verify-email.js";
import TripInvite, { tripInviteSubject } from "../../emails/trip-invite.js";

export type AuthMail = { to: string; url: string; kind: "verification" | "reset" };
export type CompanionMail = { kind: "companion-invite"; to: string; url: string; requesterName: string };
type TripMail = { kind: "trip-invite"; to: string; url: string; requesterName: string; tripName: string };
export type AppMail = AuthMail | CompanionMail | TripMail;
export type Mailer = (mail: AppMail) => Promise<void>;

export function createMailer(config: Config): Mailer {
  const logoUrl = new URL("/images/csavargo-logo.png", config.WEB_ORIGIN).href;
  const smtp = config.MAIL_PROVIDER === "smtp"
    ? nodemailer.createTransport({ host: config.SMTP_HOST, port: config.SMTP_PORT, secure: false,
      connectionTimeout: 5000, socketTimeout: 5000 }) : null;
  const resend = config.MAIL_PROVIDER === "resend" ? new Resend(config.RESEND_API_KEY) : null;
  return async (mail) => {
    const { to, url, kind } = mail;
    const props = { url, logoUrl };
    const { subject, template } = (() => {
      switch (kind) {
        case "trip-invite": return { subject: tripInviteSubject, template: createElement(TripInvite, { ...props, requesterName: mail.requesterName, tripName: mail.tripName }) };
        case "companion-invite": return { subject: companionInviteSubject, template: createElement(CompanionInvite, { ...props, requesterName: mail.requesterName }) };
        case "verification": return { subject: verifyEmailSubject, template: createElement(VerifyEmail, props) };
        case "reset": return { subject: passwordResetSubject, template: createElement(PasswordReset, props) };
      }
    })();
    const html = await render(template);
    const text = await render(template, { plainText: true });
    const email = { from: config.MAIL_FROM, to, subject, html, text };
    if (smtp) await smtp.sendMail(email);
    else if (resend) {
      const result = await resend.emails.send(email);
      if (result.error) throw new Error("Email delivery failed");
    }
  };
}
