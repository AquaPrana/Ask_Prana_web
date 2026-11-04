/**
 * Voice-turn transcript checks. These decide whether recognized speech is a
 * real user question. They do not translate or reject text only because it
 * uses an unexpected script.
 */

const NON_SPEECH_HALLUCINATIONS = [
  "thanks for watching",
  "thank you for watching",
  "please subscribe",
  "subtitles by",
  "дякую за перегляд",
  "субтитры сделал",
  "субтитры создавал",
  "підписуйтесь",
];

function spokenKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Empty recognition, or a known non-speech phrase, is not a user question. */
export function isUnclearVoiceTranscript(text: string): boolean {
  const key = spokenKey(text);
  if (!key) return true;
  return NON_SPEECH_HALLUCINATIONS.some(
    (phrase) => key === phrase || key.startsWith(`${phrase} `),
  );
}

/**
 * True when the microphone most likely heard the assistant, not a new
 * question. Short overlaps are kept so a real interruption is not swallowed.
 */
export function isAssistantEchoTranscript(transcript: string, spoken: string): boolean {
  const said = spokenKey(transcript);
  const answer = spokenKey(spoken);
  if (!said || !answer) return false;
  if (said.length >= 12 && (answer.includes(said) || said.includes(answer))) return true;
  const saidWords = said.split(" ").filter(Boolean);
  const answerWords = new Set(answer.split(" ").filter(Boolean));
  if (saidWords.length < 4) return false;
  const overlap = saidWords.filter((word) => answerWords.has(word)).length;
  return overlap / saidWords.length >= 0.72;
}
