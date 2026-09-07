/**
 * The append-local file format. The marked Source payload and the unmarked
 * local suffix have separate owners, even though the client reads one file.
 * Delimiter newlines belong to Canonfig; payload whitespace is never trimmed.
 */
export const sourceTextStart = "<!-- canonfig:source:start -->";
export const sourceTextEnd = "<!-- canonfig:source:end -->";

export type TextComposition =
  | { readonly kind: "unmanaged"; readonly local: string }
  | { readonly kind: "managed"; readonly source: string; readonly local: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const containsSourceMarker = (text: string): boolean =>
  text.includes(sourceTextStart) || text.includes(sourceTextEnd);

/** Publication validates text once, before it can become a signed payload. */
export const sourceTextIssue = (text: string): string | undefined => {
  if (text.includes("\0")) return "append-local requires text without NUL characters";
  if (decoder.decode(encoder.encode(text)) !== text) {
    return "append-local requires valid Unicode text";
  }
  return containsSourceMarker(text)
    ? "append-local Source text contains a reserved Canonfig marker"
    : undefined;
};

/**
 * Decode without replacing invalid UTF-8 or discarding a byte-order mark.
 * Partial, misplaced, and repeated delimiters are errors, not unmanaged text:
 * treating a damaged block as local text would duplicate old Source content.
 */
export const parseTextComposition = (bytes: Uint8Array): TextComposition => {
  const text = decoder.decode(bytes);
  if (text.includes("\0")) throw new Error("append-local target contains NUL characters");
  if (!containsSourceMarker(text)) return { kind: "unmanaged", local: text };

  const opening = `${sourceTextStart}\n`;
  const closing = `\n${sourceTextEnd}\n\n`;
  const end = text.indexOf(closing, opening.length);
  if (!text.startsWith(opening) || end < 0) {
    throw new Error("append-local Source markers are missing, misplaced, or malformed");
  }
  const source = text.slice(opening.length, end);
  const local = text.slice(end + closing.length);
  if (containsSourceMarker(source) || containsSourceMarker(local)) {
    throw new Error("append-local target contains repeated Source markers");
  }
  return { kind: "managed", source, local };
};

/**
 * First adoption retains the whole differing file. Without an owned baseline,
 * a diff cannot distinguish an old shared rule from a deliberate local one.
 * Once marked, only the explicit local suffix survives Source replacement.
 */
export const composeTextFile = (
  source: string,
  current?: TextComposition,
): Uint8Array => {
  const local = current === undefined
    || (current.kind === "unmanaged" && current.local === source)
    ? ""
    : current.local;
  return encoder.encode(`${sourceTextStart}\n${source}\n${sourceTextEnd}\n\n${local}`);
};
