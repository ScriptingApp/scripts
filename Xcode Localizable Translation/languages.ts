export type Language = {
  locale: string
  name: string
}

export const LANGUAGES: Language[] = [
  { locale: "zh-Hans", name: "简体中文" },
  { locale: "zh-Hant", name: "繁體中文" },
  { locale: "ja", name: "日本語" },
  { locale: "ko", name: "한국어" },
  { locale: "fr", name: "Français" },
  { locale: "de", name: "Deutsch" },
  { locale: "es", name: "Español" },
  { locale: "en-GB", name: "English (United Kingdom)" },
  { locale: "it", name: "Italiano" },
  { locale: "ru", name: "Русский" },
  { locale: "pt", name: "Português" },
  { locale: "ar", name: "العربية" },
  { locale: "hi", name: "हिन्दी" },
]

/** Common BCP-47 aliases accepted by the HTTP API. */
export const LOCALE_ALIASES: Record<string, string> = {
  "zh-cn": "zh-Hans",
  "zh-sg": "zh-Hans",
  "zh-hans-cn": "zh-Hans",
  "zh-tw": "zh-Hant",
  "zh-hk": "zh-Hant",
  "zh-mo": "zh-Hant",
  "zh-hant-tw": "zh-Hant",
  "pt-br": "pt",
  "pt-pt": "pt",
  "es-419": "es",
  "es-mx": "es",
  "en-gb": "en-GB",
}

const EXTRA_NAMES: Record<string, string> = {
  en: "English",
  "en-US": "English (United States)",
  "pt-BR": "Português (Brasil)",
  "es-419": "Español (Latinoamérica)",
}

/** Normalize an incoming locale string; unknown values are returned as-is. */
export function canonicalLocale(input: string): string {
  const value = (input ?? "").trim().replace(/_/g, "-")
  if (!value) {
    return value
  }
  const known = LANGUAGES.find(l => l.locale.toLowerCase() === value.toLowerCase())
  if (known) {
    return known.locale
  }
  const alias = LOCALE_ALIASES[value.toLowerCase()]
  return alias ?? value
}

/** Display name used inside prompts; falls back to the locale code. */
export function languageName(locale: string): string {
  const canonical = canonicalLocale(locale)
  const known = LANGUAGES.find(l => l.locale === canonical)
  if (known) {
    return known.name
  }
  return EXTRA_NAMES[canonical] ?? canonical
}

export function toLanguage(locale: string): Language {
  const canonical = canonicalLocale(locale)
  return { locale: canonical, name: languageName(canonical) }
}

/** Build a prompt language label, e.g. `简体中文 (zh-Hans)`. */
export function promptLanguage(locale: string): string {
  const canonical = canonicalLocale(locale)
  const name = languageName(canonical)
  return name === canonical ? canonical : `${name} (${canonical})`
}
