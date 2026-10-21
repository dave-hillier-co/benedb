/**
 * Ported from Spiceport `src/Spiceport.Api/GoBase64.cs`.
 *
 * Where Go's `base64.StdEncoding.DecodeString` rejects its input: the offset its `CorruptInputError`
 * reports (`illegal base64 data at input byte N`), which SpiceDB quotes when a ZedToken is not
 * base64. A port of `encoding/base64`'s `decodeQuantum`, over the input's UTF-8 bytes: newlines and
 * carriage returns are skipped, padding is required, and anything else outside the standard alphabet
 * is an error where Node's lenient decoder would skip or stop.
 *
 * Port decisions: the C#'s `int?` with a `ref int` cursor becomes `number | undefined` with the
 * cursor in a one-field box, so `decodeQuantum` keeps its shape.
 */

const PAD = 0x3d; // '='
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

interface Cursor {
  si: number;
}

/** The offset Go's decoder reports for `input`, or `undefined` when Go accepts it. */
export function corruptInputOffset(input: string): number | undefined {
  const src = Buffer.from(input, "utf8");
  const cursor: Cursor = { si: 0 };
  while (cursor.si < src.length) {
    const error = decodeQuantum(src, cursor);
    if (error !== undefined) return error;
  }
  return undefined;
}

function decodeQuantum(src: Uint8Array, cursor: Cursor): number | undefined {
  for (let j = 0; j < 4; j++) {
    if (src.length === cursor.si) return j === 0 ? undefined : cursor.si - j;

    const input = src[cursor.si]!;
    cursor.si++;

    if (isAlphabet(input)) continue;

    if (input === NEWLINE || input === CARRIAGE_RETURN) {
      j--;
      continue;
    }

    if (input !== PAD) return cursor.si - 1;

    switch (j) {
      case 0:
      case 1:
        return cursor.si - 1;
      case 2:
        skipNewlines(src, cursor);
        if (cursor.si === src.length) return src.length;
        if (src[cursor.si] !== PAD) return cursor.si - 1;
        cursor.si++;
        break;
    }

    skipNewlines(src, cursor);
    return cursor.si < src.length ? cursor.si : undefined;
  }
  return undefined;
}

function skipNewlines(src: Uint8Array, cursor: Cursor): void {
  while (
    cursor.si < src.length &&
    (src[cursor.si] === NEWLINE || src[cursor.si] === CARRIAGE_RETURN)
  ) {
    cursor.si++;
  }
}

function isAlphabet(b: number): boolean {
  return (
    (b >= 0x41 && b <= 0x5a) || // A-Z
    (b >= 0x61 && b <= 0x7a) || // a-z
    (b >= 0x30 && b <= 0x39) || // 0-9
    b === 0x2b || // +
    b === 0x2f // /
  );
}
