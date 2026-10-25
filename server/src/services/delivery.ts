// Delivery metrics for spoken answers, computed from the transcript and the recording length only. No audio is
// kept and nothing about tone, emotion, accent or personality is inferred. These never affect scores.
export const DELIVERY_VERSION = 'delivery.v1';
export const MIN_PACE_SECONDS = 10;

const START = "(?<![\\p{L}\\p{N}'’])";
const END = "(?![\\p{L}\\p{N}'’])";
const rule = (term: string, source: string, exclude?: string) => ({ term, pattern: new RegExp(source, 'giu'), exclude });
// Precision over recall: each rule counts only uses that are fillers in nearly every context. Ambiguous words
// ("like", "actually", "so", "na", "toh") are counted only in clearly filler positions or not at all.
const RULES = [
  rule('um', `${START}u+m+${END}`),
  rule('uh', `${START}u+h+m*${END}`),
  rule('erm', `${START}e+r+m+${END}`),
  rule('hmm', `${START}h+m+${END}`),
  rule('basically', `${START}basically${END}`),
  rule('literally', `${START}literally${END}`),
  // "you know" ending a clause, but not "do you know?" or "if you know".
  rule('you know', `(?<!(?:do|did|does|don't|didn't|if|whether|would|will|to|let|what|as)\\s+)${START}you know${END}(?=\\s*(?:[,.!?…]|$))`),
  rule('I mean', `${START}I mean${END}(?=\\s*,)`),
  // "like" set off by commas or opening a sentence with a comma: "it was, like, slow".
  rule('like', `(?:^|(?<=[,.!?…]\\s*))like(?=\\s*,)`),
  // Hinglish "matlab" as a discourse filler, not "iska matlab hai" (this means) or the software MATLAB.
  rule('matlab', `(?<!(?:ka|ki|ke|kya|iska|uska|jiska|kiska|का|की|के|क्या|इसका|उसका)\\s+)${START}(?:matlab|मतलब)(?=\\s*,)`, 'MATLAB'),
  rule('matlab', `(?:^|(?<=[.!?…।]\\s+))(?:matlab|मतलब)${END}(?!\\s*,)`, 'MATLAB'),
];

export type FillerCount = { term: string; count: number };
export function countFillers(text: string): FillerCount[] {
  const counts = new Map<string, number>();
  for (const { term, pattern, exclude } of RULES) {
    const found = [...text.matchAll(pattern)].filter(m => m[0] !== exclude).length;
    if (found) counts.set(term, (counts.get(term) ?? 0) + found);
  }
  return [...counts].map(([term, count]) => ({ term, count })).sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
}

export const countWords = (text: string) => text.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word)).length;

export function analyzeDelivery(transcript: string, seconds: number) {
  const words = countWords(transcript);
  return { seconds, words, wordsPerMinute: paceOf(words, seconds), fillers: countFillers(transcript), version: DELIVERY_VERSION };
}
// Pace is shown only for at least ten seconds of speech; shorter clips give unstable numbers.
export const paceOf = (words: number, seconds: number) => seconds >= MIN_PACE_SECONDS ? Math.round(words / (seconds / 60)) : null;
