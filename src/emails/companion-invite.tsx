import { EmailAccent, EmailLayout } from "../lib/email-layout.js";

export const companionInviteSubject = "Útitársjelölés érkezett";

export default function CompanionInvite({ requesterName, url, logoUrl }: { requesterName: string; url: string; logoUrl?: string }) {
  return <EmailLayout subject={companionInviteSubject} title={<>Útitársjelölés <EmailAccent>érkezett</EmailAccent></>}
    artwork="invite" action="Jelölés megtekintése" url={url} logoUrl={logoUrl}>
    <strong>{requesterName}</strong> útitársnak jelölt a Csavargón. Az Útitársak oldalon elfogadhatod vagy elutasíthatod a jelölést.
  </EmailLayout>;
}

CompanionInvite.PreviewProps = { requesterName: "Kovács Anna", url: "http://localhost:3000/belepes?folytatas=utitarsak" };
