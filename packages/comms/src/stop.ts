/**
 * Opt-out keywords in English, Albanian and Arabic. A message opts out only when the
 * whole message is one keyword (after normalising case, punctuation, diacritics and
 * Arabic letter variants), so "please don't stop the reminders" never unsubscribes.
 */

const KEYWORDS = {
  en: ["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout", "opt out"],
  sq: ["ndalo", "ndal", "cregjistrohu", "cabonohu", "mjaft", "stop"],
  ar: ["توقف", "ايقاف", "الغاء", "الغاء الاشتراك", "قف", "اوقف"],
} as const;

export const STOP_KEYWORDS: readonly string[] = [...new Set(Object.values(KEYWORDS).flat())];

export function normalizeKeyword(text: string): string {
  return (
    text
      .normalize("NFKD")
      // Latin combining marks (ç -> c, ë -> e) and Arabic harakat/tatweel.
      .replace(/[\u0300-\u036f\u064b-\u065f\u0670\u0640]/g, "")
      .normalize("NFKC")
      .replace(/[إأآٱ]/g, "ا")
      .replace(/ى/g, "ي")
      .toLowerCase()
      // Telegram commands ("/stop", "/stop@SchoolBot") and surrounding punctuation.
      .replace(/^\//, "")
      .replace(/@\w+$/, "")
      .replace(/[\p{P}\p{S}]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

const NORMALIZED = new Set(STOP_KEYWORDS.map(normalizeKeyword));

export function isStopKeyword(text: string): boolean {
  const n = normalizeKeyword(text);
  return n.length > 0 && NORMALIZED.has(n);
}
