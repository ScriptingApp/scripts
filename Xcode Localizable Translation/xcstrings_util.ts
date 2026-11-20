export type StringUnit = {
  state: string
  value: string
}

export type LocalizationEntry = {
  stringUnit?: StringUnit
  /** Plural / device variations; unsupported by the batch pipeline for now. */
  variations?: Record<string, unknown>
}

export type StringEntry = {
  comment?: string
  extractionState?: string
  shouldTranslate?: boolean
  localizations?: {
    [locale: string]: LocalizationEntry
  }
  /** Plural / device variations; unsupported by the batch pipeline for now. */
  variations?: Record<string, unknown>
}

export type LocalizableStrings = {
  [key: string]: StringEntry
}

export type LocalizableData = {
  sourceLanguage: string
  strings: LocalizableStrings
  version: string
}

export const isLocalizableData = (
  value: unknown
): value is LocalizableData => {
  if (!value || typeof value !== "object") {
    return false
  }
  const data = value as LocalizableData
  return !!data.strings && typeof data.strings === "object" && !Array.isArray(data.strings)
}

export const readLocalizableData = async (
  filePath: string
): Promise<LocalizableData | null> => {
  try {
    let content = await FileManager.readAsString(
      filePath
    )
    const data: LocalizableData = JSON.parse(
      content
    )
    return data
  } catch (e) {
    console.error("Error parsing JSON:", e)
    return null
  }
}

/** Entries using plural/device variations are skipped until we support them. */
export const entryHasVariations = (entry: StringEntry): boolean => {
  if (entry.variations && Object.keys(entry.variations).length > 0) {
    return true
  }
  const localizations = entry.localizations
  if (!localizations) {
    return false
  }
  return Object.values(localizations).some(
    unit => unit?.variations && Object.keys(unit.variations).length > 0,
  )
}

/**
 * Whether a single entry still needs a translation for `locale`.
 *
 * Covers more than a missing entry: Xcode also produces empty values and
 * `state: "new"` entries when the source string changed, and both need work.
 */
export const needsTranslation = (
  entry: StringEntry | undefined,
  locale: string,
): boolean => {
  if (!entry || entry.shouldTranslate === false) {
    return false
  }
  if (entryHasVariations(entry)) {
    return false
  }
  const unit = entry.localizations?.[locale]?.stringUnit
  if (!unit) {
    return true
  }
  if (typeof unit.value !== "string" || unit.value.trim() === "") {
    return true
  }
  return unit.state === "new"
}

export const findKeysToTranslate = (
  data: LocalizableData,
  locale: string
): string[] => {
  const keysToTranslate: string[] = []

  for (const key in data.strings) {
    if (key.trim() === "") {
      continue
    }
    if (needsTranslation(data.strings[key], locale)) {
      keysToTranslate.push(key)
    }
  }

  return keysToTranslate
}

/** Keys Xcode marked as no longer present in the source. */
export const findStaleKeys = (data: LocalizableData): string[] => {
  return Object.keys(data.strings).filter(
    key => data.strings[key]?.extractionState === "stale",
  )
}

/** Keys that are pure whitespace (Xcode artifacts) or the empty string. */
export const findEmptyKeys = (data: LocalizableData): string[] => {
  return Object.keys(data.strings).filter(key => key.trim() === "")
}

export const mergeTranslationList = (
  data: LocalizableData,
  keys: string[],
  translations: (string | null)[],
  locale: string
) => {
  const map: Record<string, string> = {}
  keys.forEach((key, index) => {
    const value = translations[index]
    if (typeof value === "string") {
      map[key] = value
    }
  })
  mergeTranslations(data, map, locale)
}

export const mergeTranslations = (
  data: LocalizableData,
  translationMap: Record<string, string>,
  locale: string
) => {
  Object
    .entries(translationMap)
    .forEach(([key, content]) => {
      let info = data.strings[key]
      if (!info || info.shouldTranslate === false) {
        return
      }

      if (info.localizations == null) {
        info.localizations = {}
      }

      info.localizations[locale] = {
        stringUnit: {
          state: "translated",
          value: content
        }
      }
    })
}
