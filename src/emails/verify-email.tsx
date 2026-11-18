import { EmailAccent, EmailLayout } from "../lib/email-layout.js";

export const verifyEmailSubject = "Erősítsd meg az e-mail-címedet";

export default function VerifyEmail({ url, logoUrl }: { url: string; logoUrl?: string }) {
  return <EmailLayout subject={verifyEmailSubject} title={<>Erősítsd meg az <EmailAccent>e-mail-címedet</EmailAccent></>}
    artwork="verify" action="E-mail-cím megerősítése" url={url} logoUrl={logoUrl}>
    Az e-mail-címed megerősítéséhez kattints az alábbi hivatkozásra. A hivatkozás 24 óráig érvényes.
  </EmailLayout>;
}

VerifyEmail.PreviewProps = { url: "http://localhost:3000/email-megerosites" };
