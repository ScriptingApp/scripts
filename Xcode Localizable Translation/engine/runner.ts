import { LocalizableData } from "../xcstrings_util"
import { ProviderSelection } from "../translate"
import { Language } from "../languages"
import { SchedulerController } from "./scheduler"
import { translateXcstrings } from "./translation_service"

export type { LocaleProgress } from "./translation_service"

import type { LocaleProgress } from "./translation_service"

export type RunnerCallbacks = {
  onLog: (message: string) => void
  onProgress: (progress: Record<string, LocaleProgress>) => void
}

export type RunnerOptions = {
  data: LocalizableData
  languages: Language[]
  selection: ProviderSelection
  concurrency: number
  intervalMs: number
  controller: SchedulerController
  callbacks: RunnerCallbacks
  /** Number of items per translation request. Defaults to 30. */
  batchSize?: number
}

/**
 * UI adapter over the shared translation service.
 * Mutates `data` in place via mergeTranslationList. Returns final progress.
 */
export async function runTranslation(
  options: RunnerOptions,
): Promise<Record<string, LocaleProgress>> {
  return translateXcstrings({
    data: options.data,
    languages: options.languages,
    selection: options.selection,
    concurrency: options.concurrency,
    intervalMs: options.intervalMs,
    batchSize: options.batchSize,
    controller: options.controller,
    onLog: options.callbacks.onLog,
    onProgress: options.callbacks.onProgress,
  })
}
