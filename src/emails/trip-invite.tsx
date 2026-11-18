import { EmailAccent, EmailLayout } from "../lib/email-layout.js";

export const tripInviteSubject = "Meghívást kaptál egy utazásra";

export default function TripInvite({ requesterName, tripName, url, logoUrl }: {
  requesterName: string; tripName: string; url: string; logoUrl?: string;
}) {
  return <EmailLayout subject={tripInviteSubject} title={<>Meghívást kaptál <EmailAccent>egy utazásra</EmailAccent></>}
    artwork="invite" action="Meghívás megtekintése" url={url} logoUrl={logoUrl}>
    <strong>{requesterName}</strong> meghívott erre az utazásra: <strong>{tripName}</strong>. Az Utazások oldalon válaszolhatsz a meghívásra.
  </EmailLayout>;
}

TripInvite.PreviewProps = { requesterName: "Kovács Anna", tripName: "Hétvége Prágában", url: "http://localhost:3000/belepes?folytatas=utazasok" };
