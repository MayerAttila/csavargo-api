export function safeRequestUrl(url?: string) {
  return url?.split("?")[0].replace(/(\/api\/auth\/reset-password\/)[^/]+/, "$1[REDACTED]");
}
