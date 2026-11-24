import { createWriteStream } from "node:fs";
import { PassThrough } from "node:stream";

export function safeRequestUrl(url?: string) {
  return url?.split("?")[0].replace(/(\/api\/auth\/reset-password\/)[^/]+/, "$1[REDACTED]");
}

export function createDevelopmentLog() {
  const stream = new PassThrough();
  const file = createWriteStream("backend.log", { flags: "a" });
  file.on("error", () => {
    stream.unpipe(file);
    process.stderr.write("Could not write the development backend.log file.\n");
  });
  stream.pipe(process.stdout, { end: false });
  stream.pipe(file);
  return stream;
}
