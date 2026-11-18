import type { ReactNode } from "react";
import { Body, Button, Container, Head, Heading, Html, Img, Preview, Text } from "@react-email/components";

type Props = {
  subject: string;
  title: ReactNode;
  action: string;
  url: string;
  logoUrl?: string;
  artwork: "invite" | "reset" | "verify";
  children: ReactNode;
};

export function EmailLayout({ subject, title, action, url, logoUrl, artwork, children }: Props) {
  const logo = logoUrl ?? new URL("/images/csavargo-logo.png", url).href;
  const background = new URL(`/images/email-${artwork}.jpg`, logo).href;

  return <Html lang="hu">
    <Head>
      <meta name="color-scheme" content="dark" />
      <meta name="supported-color-schemes" content="dark" />
      <style>{`
        @media only screen and (max-width: 540px) {
          .email-card {
            padding: 24px 22px 162px !important;
            background-image: linear-gradient(to bottom, #101929, rgba(16,25,41,0) 28%), url("${background}") !important;
            background-size: 100% 230px, 460px auto !important;
            background-position: right bottom, right bottom !important;
          }
          .email-copy { width: 100% !important; }
          .email-title { font-size: 25px !important; line-height: 31px !important; }
        }
      `}</style>
    </Head>
    <Preview>{subject}</Preview>
    <Body style={{ margin: 0, padding: "28px 12px", backgroundColor: "#0c111c", color: "#f8fafc", fontFamily: "Arial, sans-serif" }}>
      <Container style={{ margin: "0 auto", maxWidth: 640 }}>
        <table role="presentation" cellPadding="0" cellSpacing="0" width="100%">
          <tbody>
            <tr>
              <td className="email-card" {...{ background }} style={{
                backgroundColor: "#101929", backgroundImage: `url("${background}")`, backgroundRepeat: "no-repeat",
                backgroundSize: "cover", backgroundPosition: "right bottom", border: "1px solid #344861",
                borderRadius: 20, padding: "28px 34px 34px",
              }}>
                <table role="presentation" cellPadding="0" cellSpacing="0">
                  <tbody>
                    <tr>
                      <td style={{ verticalAlign: "middle" }}><Img src={logo} alt="Csavargó" width={42} height={42} style={{ display: "block" }} /></td>
                      <td aria-hidden="true" style={{ paddingLeft: 6, verticalAlign: "middle", color: "#f8fafc", fontSize: 18, fontWeight: 700 }}>Csavargó</td>
                    </tr>
                  </tbody>
                </table>
                <table role="presentation" cellPadding="0" cellSpacing="0" width="72%" className="email-copy">
                  <tbody>
                    <tr>
                      <td style={{ paddingTop: 16 }}>
                        <Heading as="h1" className="email-title" style={{ margin: "0 0 12px", color: "#f8fafc", fontSize: 30, lineHeight: "36px", fontWeight: 700 }}>
                          {title}
                        </Heading>
                        <Text style={{ margin: "0 0 22px", color: "#d7e1ee", fontSize: 16, lineHeight: "24px" }}>{children}</Text>
                        <Button href={url} style={{
                          backgroundColor: "#344ed2", border: "1px solid #6980f4", borderRadius: 14,
                          color: "#ffffff", padding: "12px 18px", fontSize: 16, lineHeight: "22px", fontWeight: 700,
                        }}>
                          {action} <span aria-hidden="true" style={{ paddingLeft: 4 }}>→</span>
                        </Button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </Container>
    </Body>
  </Html>;
}

export function EmailAccent({ children }: { children: ReactNode }) {
  return <span style={{ color: "#58eda3" }}>{children}</span>;
}
