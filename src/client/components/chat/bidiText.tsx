export type TextDirection = "ltr" | "rtl";

// Isolate addresses, file paths and numeric ranges without their surrounding
// sentence punctuation. Markdown handles code and commands with spaces.
const technicalToken =
  /(?<![\p{L}\p{N}_])(?:(?:https?:\/\/|www\.|[a-z]:\\|(?:~|\.{1,2})?\/)[^\s<>"'`،؛؟]+|(?:[a-z0-9_.-]+\/)+[a-z0-9_.-]+\.[a-z0-9]+|\p{Nd}+(?:[-–/:]\p{Nd}+)+)/giu;
const numericExpression = /^\p{Nd}+(?:[-–/:]\p{Nd}+)+$/u;
const trailingPunctuation = /[.,;:!?،؛؟)\]}]+$/u;
const rtlLetter =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}]/u;

export function splitTechnicalText(text: string) {
  const parts: { text: string; isolate?: "bdi" | "bdo"; start: number }[] = [];
  let offset = 0;
  for (const match of text.matchAll(technicalToken)) {
    const token = match[0].replace(trailingPunctuation, "");
    if (offset < match.index) {
      parts.push({
        text: text.slice(offset, match.index),
        start: offset,
      });
    }
    // Arabic-Indic digits can reorder around a dash even in an LTR isolate.
    parts.push({
      text: token,
      isolate: numericExpression.test(token) ? "bdo" : "bdi",
      start: match.index,
    });
    offset = match.index + token.length;
  }
  if (offset < text.length) {
    parts.push({ text: text.slice(offset), start: offset });
  }
  return parts;
}

export function firstTextDirection(text: string): TextDirection | undefined {
  const letter = /\p{L}/u.exec(text)?.[0];
  if (letter) return rtlLetter.test(letter) ? "rtl" : "ltr";
}

export function BidiText({ text }: { text: string }) {
  return splitTechnicalText(text).map(({ text: fragment, isolate: Isolate, start }) =>
    Isolate ? (
      <Isolate key={start} dir="ltr">
        {fragment}
      </Isolate>
    ) : (
      fragment
    ),
  );
}
