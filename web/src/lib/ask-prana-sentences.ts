const SENTENCE_END = /[.!?।॥\n]/u;

/**
 * Pulls finished sentences out of a growing voice-answer buffer.
 * A sentence is ready only after . ! ? । ॥ or a newline, and a period between
 * digits (3.5) stays inside the sentence. The unfinished tail is returned so
 * the next model chunk can complete it. Flush emits that tail when generation
 * ends, including text that never received punctuation.
 */
export function takeCompleteSentences(
  buffer: string,
  flush: boolean,
): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const character = buffer[index];
    if (!character || !SENTENCE_END.test(character)) continue;
    if (
      character === "." &&
      index > 0 &&
      index + 1 < buffer.length &&
      isDigit(buffer[index - 1]) &&
      isDigit(buffer[index + 1])
    ) {
      continue;
    }
    let end = index + 1;
    while (end < buffer.length && /["')\]]/u.test(buffer[end] ?? "")) end += 1;
    const after = buffer[end];
    if (!flush && after !== undefined && character !== "\n" && !/\s/u.test(after)) {
      continue;
    }
    if (!flush && after === undefined) break;
    const sentence = buffer.slice(start, end).replace(/\s+/g, " ").trim();
    if (sentence) sentences.push(sentence);
    start = end;
    while (start < buffer.length && /\s/u.test(buffer[start] ?? "")) start += 1;
    index = start - 1;
  }
  const rest = buffer.slice(start);
  if (flush) {
    const tail = rest.replace(/\s+/g, " ").trim();
    if (tail) sentences.push(tail);
    return { sentences, rest: "" };
  }
  return { sentences, rest };
}

export function splitCompleteSentences(text: string): string[] {
  return takeCompleteSentences(text, true).sentences;
}

function isDigit(value: string | undefined) {
  return Boolean(value && value >= "0" && value <= "9");
}
