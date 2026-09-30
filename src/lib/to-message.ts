// dicom-parser throws plain strings, so `e.message` is undefined for most failures. Shared by the
// metadata and pixel workers' handlers, so neither duplicates - or drifts from - the other's
// normalisation of what a thrown value actually says.
export function toMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e === undefined || e === null) return "";
  return String(e);
}
