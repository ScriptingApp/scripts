/**
 * Headless translation service used by both the page UI and the HTTP server.
 *
 * Responsibilities:
 * - deduplicate texts and restore the original order
 * - split work into batches and run them through the scheduler
 * - merge xcstrings translations without touching existing localizations
 * - resolve the provider/model from persisted settings
 */

import {
  LocalizableData,
  findKeysToTranslate,
  mergeTranslationList,
} from "../xcstrings_util"
import { ProviderSelection, TranslationProfile, translate } from "../translate"
import { Language, canonicalLocale, promptLanguage } from "../languages"
import { runTasks, SchedulerController } from "./scheduler"
import {
  TranslationSettings,
  discoverProviders,
  toProviderSelection,
  ProviderOption,
} from "../store"
import { t } from "../i18n"

export const DEFAULT_BATCH_SIZE = 30

export type LocaleProgress = {
  locale: string
  name: string
  total: number
  done: number
  failed: number
  status: "pending" | "running" | "completed" | "partial"
}

export type TextTranslateInput = {
  texts: string[]
  /** Locale codes; aliases such as zh-CN are normalized. */
  targets: string[]
  source?: string
  profile?: TranslationProfile
  context?: string
  selection: ProviderSelection
  batchSize?: number
  concurrency?: number
  intervalMs?: number
  controller?: SchedulerController
  onProgress?: (progress: Record<string, LocaleProgress>) => void
}

export type TextTranslateStats = {
  texts: number
  unique: number
  targets: number
  batches: number
  elapsedMs: number
  done: number
  failed: number
}

export type TextTranslateResult = {
  /** Aligned with input texts; null marks a failed slot. */
  results: Record<string, (string | null)[]>
  /** Original indexes that failed, per locale. */
  failed: Record<string, number[]>
  stats: TextTranslateStats
}

export type XcstringsTranslateOptions = {
  data: LocalizableData
  languages: Language[]
  selection: ProviderSelection
  concurrency: number
  intervalMs: number
  batchSize?: number
  controller: SchedulerController
  /** Optional UI log sink. */
  onLog?: (message: string) => void
  onProgress?: (progress: Record<string, LocaleProgress>) => void
}

export class ProviderNotConfiguredError extends Error {
  constructor(message = "No valid provider is configured") {
    super(message)
    this.name = "ProviderNotConfiguredError"
  }
}

/** Resolve the persisted provider/model selection for a new job. */
export async function resolveProviderSelection(
  settings: TranslationSettings,
): Promise<{ selection: ProviderSelection; option: ProviderOption }> {
  const providers = await discoverProviders()
  const option = providers.find(item => item.key === settings.providerKey)
  if (!option) {
    throw new ProviderNotConfiguredError(
      `Provider "${settings.providerKey}" is not configured`,
    )
  }
  return {
    selection: toProviderSelection(option, settings.modelId),
    option,
  }
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? Number(value) : fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function makeProgress(locale: string, total: number, name?: string): LocaleProgress {
  return {
    locale,
    name: name ?? promptLanguage(locale),
    total,
    done: 0,
    failed: 0,
    status: total === 0 ? "completed" : "pending",
  }
}

function dedupe(texts: string[]): { unique: string[]; indexOf: number[] } {
  const unique: string[] = []
  const lookup = new Map<string, number>()
  const indexOf: number[] = []
  texts.forEach(text => {
    let index = lookup.get(text)
    if (index === undefined) {
      index = unique.length
      lookup.set(text, index)
      unique.push(text)
    }
    indexOf.push(index)
  })
  return { unique, indexOf }
}

type TextTask = {
  locale: string
  language: string
  contents: string[]
  offset: number
}

/**
 * Translate a list of plain texts into one or more target locales.
 * Duplicate texts are translated once and mapped back to every occurrence.
 */
export async function translateTexts(
  input: TextTranslateInput,
): Promise<TextTranslateResult> {
  const startedAt = Date.now()
  const controller = input.controller ?? new SchedulerController()
  const batchSize = clamp(input.batchSize, DEFAULT_BATCH_SIZE, 1, 100)
  const concurrency = clamp(input.concurrency, 1, 1, 5)
  const intervalMs = clamp(input.intervalMs, 1000, 0, 60000)
  const targets = Array.from(new Set(input.targets.map(canonicalLocale).filter(Boolean)))

  if (input.texts.length === 0) {
    return {
      results: {},
      failed: {},
      stats: {
        texts: 0,
        unique: 0,
        targets: targets.length,
        batches: 0,
        elapsedMs: 0,
        done: 0,
        failed: 0,
      },
    }
  }

  if (targets.length === 0) {
    throw new Error("At least one target locale is required")
  }

  const { unique, indexOf } = dedupe(input.texts)
  const context = [input.context, input.source ? `源语言：${input.source}` : ""]
    .filter(Boolean)
    .join("\n")

  const progress: Record<string, LocaleProgress> = {}
  const uniqueResults: Record<string, (string | null)[]> = {}
  const tasks: TextTask[] = []

  for (const locale of targets) {
    progress[locale] = makeProgress(locale, unique.length)
    uniqueResults[locale] = new Array(unique.length).fill(null)
    const language = promptLanguage(locale)
    for (let i = 0; i < unique.length; i += batchSize) {
      tasks.push({
        locale,
        language,
        contents: unique.slice(i, i + batchSize),
        offset: i,
      })
    }
  }

  const emitProgress = () => input.onProgress?.({ ...progress })

  await runTasks<TextTask, string[] | null>(
    {
      tasks,
      concurrency,
      intervalMs,
      worker: async (task, signal) => {
        const p = progress[task.locale]
        if (p.status === "pending") {
          p.status = "running"
          emitProgress()
        }
        return translate({
          contents: task.contents,
          language: task.language,
          selection: input.selection,
          profile: input.profile ?? "plain",
          context: context || undefined,
          signal,
        })
      },
      onResult: (translations, task) => {
        const p = progress[task.locale]
        if (!translations) {
          p.failed += task.contents.length
        } else {
          translations.forEach((value, i) => {
            uniqueResults[task.locale][task.offset + i] = value
          })
          p.done += translations.length
        }
        if (p.done + p.failed >= p.total) {
          p.status = p.failed > 0 ? "partial" : "completed"
        }
        emitProgress()
      },
      onError: (_error, task) => {
        const p = progress[task.locale]
        p.failed += task.contents.length
        if (p.done + p.failed >= p.total) {
          p.status = "partial"
        }
        emitProgress()
      },
    },
    controller,
  )

  const results: Record<string, (string | null)[]> = {}
  const failed: Record<string, number[]> = {}
  let done = 0
  let failedCount = 0

  for (const locale of targets) {
    const perText = uniqueResults[locale]
    const aligned = indexOf.map(index => perText[index] ?? null)
    results[locale] = aligned
    const bad: number[] = []
    aligned.forEach((value, index) => {
      if (value === null) {
        bad.push(index)
      }
    })
    failed[locale] = bad
    done += aligned.length - bad.length
    failedCount += bad.length
  }

  return {
    results,
    failed,
    stats: {
      texts: input.texts.length,
      unique: unique.length,
      targets: targets.length,
      batches: tasks.length,
      elapsedMs: Date.now() - startedAt,
      done,
      failed: failedCount,
    },
  }
}

/**
 * Translate missing localizations of a Localizable.xcstrings document in place.
 * Existing localizations and `shouldTranslate: false` entries are preserved.
 */
export async function translateXcstrings(
  options: XcstringsTranslateOptions,
): Promise<Record<string, LocaleProgress>> {
  const {
    data,
    languages,
    selection,
    concurrency,
    intervalMs,
    controller,
    onLog,
    onProgress,
  } = options
  const batchSize = clamp(options.batchSize, DEFAULT_BATCH_SIZE, 1, 100)

  const progress: Record<string, LocaleProgress> = {}
  const tasks: Array<{
    locale: string
    language: string
    contents: string[]
  }> = []

  for (const lang of languages) {
    const keys = findKeysToTranslate(data, lang.locale)
    progress[lang.locale] = makeProgress(lang.locale, keys.length, lang.name)
    const language = promptLanguage(lang.locale)
    for (let i = 0; i < keys.length; i += batchSize) {
      tasks.push({
        locale: lang.locale,
        language,
        contents: keys.slice(i, i + batchSize),
      })
    }
  }

  const emitProgress = () => onProgress?.({ ...progress })
  emitProgress()

  if (tasks.length === 0) {
    onLog?.(t.runNothing)
    return progress
  }

  onLog?.(t.runTotalBatches(tasks.length, concurrency, intervalMs))

  await runTasks<
    { locale: string; language: string; contents: string[] },
    string[] | null
  >(
    {
      tasks,
      concurrency,
      intervalMs,
      worker: async (task, signal) => {
        const p = progress[task.locale]
        if (p.status === "pending") {
          p.status = "running"
          emitProgress()
        }
        onLog?.(t.runBatchProcessing(task.language, task.contents.length))
        return translate({
          contents: task.contents,
          language: task.language,
          selection,
          profile: "xcstrings",
          signal,
        })
      },
      onResult: (translations, task) => {
        const p = progress[task.locale]
        if (translations && translations.length > 0) {
          mergeTranslationList(data, task.contents, translations, task.locale)
          p.done += translations.length
        } else {
          p.failed += task.contents.length
          onLog?.(t.runBatchFailed(task.language))
        }
        if (p.done + p.failed >= p.total) {
          p.status = p.failed > 0 ? "partial" : "completed"
        }
        emitProgress()
      },
      onError: (error, task) => {
        const p = progress[task.locale]
        p.failed += task.contents.length
        if (p.done + p.failed >= p.total) {
          p.status = "partial"
        }
        const message = error instanceof Error ? error.message : String(error)
        onLog?.(t.runBatchError(task.language, message))
        emitProgress()
      },
    },
    controller,
  )

  return progress
}
