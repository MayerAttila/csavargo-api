import { EmailAccent, EmailLayout } from "../lib/email-layout.js";

export const passwordResetSubject = "Csavargó – Új jelszó beállítása";

export default function PasswordReset({ url, logoUrl }: { url: string; logoUrl?: string }) {
  return <EmailLayout subject={passwordResetSubject} title={<>Csavargó – <EmailAccent>Új jelszó</EmailAccent> beállítása</>}
    artwork="reset" action="Új jelszó beállítása" url={url} logoUrl={logoUrl}>
    Új jelszó beállításához kattints az alábbi hivatkozásra. A hivatkozás 1 óráig érvényes. Ha nem te kérted, hagyd figyelmen kívül ezt a levelet.
  </EmailLayout>;
}

PasswordReset.PreviewProps = { url: "http://localhost:3000/uj-jelszo" };
