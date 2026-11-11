// A headline's sentences, so the page can put each on its own line: after ". " in English, after "。" in Chinese and Japanese.
export function splitSentences(text: string): string[] {
  return text.split(/(?<=\.)\s+|(?<=。)/).map((sentence) => sentence.trim()).filter((sentence) => sentence !== '');
}
