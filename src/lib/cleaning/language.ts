import { stripDiacritics } from "./text";

export type Lang = "en" | "de" | "fr" | "unknown";

const STOPWORDS: Record<Exclude<Lang, "unknown">, string[]> = {
  en: [
    "the", "and", "with", "for", "this", "is", "are", "of", "to", "in", "made", "from", "not",
    "your", "our", "can", "be", "use", "only", "suitable", "hand", "wash", "it", "a", "an", "on",
  ],
  de: [
    "der", "die", "das", "und", "mit", "für", "fur", "ist", "aus", "nicht", "ein", "eine", "zu",
    "im", "von", "auf", "geeignet", "handwäsche", "nur", "bei", "sind", "oder", "dem", "den", "sehr",
  ],
  fr: [
    "le", "la", "les", "et", "avec", "pour", "est", "de", "du", "des", "en", "une", "un", "pas",
    "ne", "fait", "main", "lavage", "seulement", "convient", "sur", "dans", "au", "aux",
  ],
};

const SETS = Object.fromEntries(
  Object.entries(STOPWORDS).map(([lang, words]) => [lang, new Set(words.map((w) => stripDiacritics(w)))]),
) as Record<Exclude<Lang, "unknown">, Set<string>>;

export interface LanguageGuess {
  lang: Lang;
  confidence: number;
}

/**
 * Small deterministic detector for EN/DE/FR supplier text: stopword hits plus orthographic signals
 * (umlauts/ß for German; accents/ç/œ for French). Short or ambiguous text returns "unknown".
 */
export function detectLanguage(text: string): LanguageGuess {
  const lower = text.toLowerCase();
  const words = stripDiacritics(lower).split(/[^a-z]+/).filter((w) => w.length > 0);
  const score: Record<Exclude<Lang, "unknown">, number> = { en: 0, de: 0, fr: 0 };
  for (const w of words) {
    for (const lang of ["en", "de", "fr"] as const) if (SETS[lang].has(w)) score[lang] += 1;
  }
  score.de += (lower.match(/[äöüß]/g)?.length ?? 0) * 1.5;
  score.fr += (lower.match(/[éèêàçœùâî]/g)?.length ?? 0) * 1.5;
  // German compound markers common in product copy.
  score.de += (lower.match(/(ung|keit|lich|frostfest|winterhart|spülmaschinen)/g)?.length ?? 0) * 0.5;

  const ranked = (Object.entries(score) as Array<[Exclude<Lang, "unknown">, number]>).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  const total = ranked.reduce((s, [, v]) => s + v, 0);
  if (best[1] < 1.5 || best[1] === second[1]) return { lang: "unknown", confidence: 0 };
  return { lang: best[0], confidence: Math.round((best[1] / total) * 100) };
}
