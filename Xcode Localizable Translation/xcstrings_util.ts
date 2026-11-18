export type LocalizableStrings = {
  [key: string]: {
    localizations?: {
      [locale: string]: {
        stringUnit: {
          state: string
          value: string
        }
      }
    }
    shouldTranslate?: boolean
    extractionState?: string
  }
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

export const findKeysToTranslate = (
  data: LocalizableData,
  locale: string
): string[] => {
  const keysToTranslate: string[] = []

  for (const key in data.strings) {
    if (key === "") {
      continue
    }
    const stringEntry = data.strings[key]
    if (stringEntry.shouldTranslate !== false
      && stringEntry.localizations?.[locale] == null
    ) {
      keysToTranslate.push(key)
    }
  }

  return keysToTranslate
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
      if (info.shouldTranslate === false) {
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