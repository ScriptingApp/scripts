/**
 * Project-level batch translation over a directory of `*.xcstrings` files.
 *
 * Processing model (deliberately conservative):
 * - **one file at a time**; a file is scanned, translated and patched before the
 *   next one starts, so model requests stay sequential and rate limits are less
 *   likely. Dedupe happens *within* a file only — no cross-file merging, which
 *   keeps request payloads small and lets each file's context stand alone.
 * - **partial success is written**: whatever came back is patched into the file
 *   immediately; failed texts are retried in smaller batches before moving on.
 * - `maxRequests` caps the number of model requests per run; a run stops after
 *   the current file, and the next run simply re-scans and continues.
 * - files are patched as text (style preserving) and verified before writing,
 *   so a bug can never corrupt a 9 MB Localizable.xcstrings.
 */

import { ProviderSelection, translate } from "../translate"
import { promptLanguage } from "../languages"
import {
  LocalizableData,
  findKeysToTranslate,
  findStaleKeys,
  needsTranslation,
} from "../xcstrings_util"
import { LocaleInsert, patchXcstrings, verifyPatch } from "../xcstrings_patch"
import { SchedulerController, runTasks } from "./scheduler"

export type BatchPruneMode = "off" | "all" | "file"

export type BatchOptions = {
  /** Directory containing the xcstrings files (searched recursively). */
  dir: string
  /** Target locales; the file's own `sourceLanguage` is always skipped. */
  targets: string[]
  selection: ProviderSelection
  prune?: BatchPruneMode
  /** For `prune: "file"`: relative path -> keys to delete. */
  pruneMap?: Record<string, string[]>
  /** Write patched files back. When false the run only reports. */
  write?: boolean
  /** Copy the original file under `<dir>/.backup/<stamp>/` before writing. */
  backup?: boolean
  /** Maximum number of model requests for this run. */
  maxRequests?: number
  /** Extra rounds for failed texts, each with a smaller batch. Default 2. */
  retries?: number
  batchSize?: number
  concurrency?: number
  intervalMs?: number
  /** Only handle files whose relative path contains this substring. */
  filter?: string
  reportPath?: string
  /** Full list of texts that still failed, for the next retry run. */
  failedPath?: string
  controller?: SchedulerController
  onLog?: (message: string) => void
}

export type FailedText = { locale: string; key: string }

export type BatchFileSummary = {
  path: string
  pending: number
  added: number
  replaced: number
  pruned: number
  requests: number
  failed: number
  changed: boolean
  error?: string
  /** Capped for the report; the full list goes to `failedPath`. */
  failedSample?: FailedText[]
}

export type BatchReport = {
  ok: boolean
  dir: string
  files: number
  targets: string[]
  pendingBefore: number
  requests: number
  translated: number
  failed: number
  remaining: number
  pruned: number
  changedFiles: string[]
  stoppedBy: "done" | "maxRequests" | "cancelled" | "writeDisabled"
  elapsedMs: number
  errors: string[]
  filesSummary: BatchFileSummary[]
}

type Task = { locale: string; contents: string[]; attempt: number }

const FAILED_SAMPLE_LIMIT = 20

function relativePath(dir: string, path: string): string {
  const prefix = dir.endsWith("/") ? dir : dir + "/"
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

function timestamp(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

async function listFiles(dir: string, filter?: string): Promise<string[]> {
  const entries = await FileManager.readDirectory(dir, true)
  return entries
    .map(path => (path.startsWith("/") ? path : `${dir}/${path}`))
    .filter(path => path.endsWith(".xcstrings"))
    .filter(path => !path.includes("/.backup/"))
    .filter(path => !filter || relativePath(dir, path).includes(filter))
    .sort()
}

async function readData(path: string): Promise<{ raw: string; data: LocalizableData }> {
  const raw = await FileManager.readAsString(path)
  const data = JSON.parse(raw) as LocalizableData
  if (!data || typeof data !== "object" || typeof data.strings !== "object") {
    throw new Error("missing strings object")
  }
  return { raw, data }
}

async function writeBackup(dir: string, stamp: string, path: string, raw: string): Promise<void> {
  const target = `${dir}/.backup/${stamp}/${relativePath(dir, path)}`
  const folder = target.slice(0, target.lastIndexOf("/"))
  await FileManager.createDirectory(folder, true)
  await FileManager.writeAsString(target, raw)
}

/** Batches for a single file, deduplicated across that file's entries. */
function buildFileTasks(
  data: LocalizableData,
  targets: string[],
  batchSize: number,
  skip: Set<string>,
): Task[] {
  const tasks: Task[] = []
  for (const locale of targets) {
    if (locale === data.sourceLanguage) {
      continue
    }
    const keys = findKeysToTranslate(data, locale).filter(key => !skip.has(key))
    if (keys.length === 0) {
      continue
    }
    for (let i = 0; i < keys.length; i += batchSize) {
      tasks.push({ locale, contents: keys.slice(i, i + batchSize), attempt: 0 })
    }
  }
  return tasks
}

/**
 * Translate every missing localization under `options.dir`, one file at a time.
 */
export async function runBatch(options: BatchOptions): Promise<BatchReport> {
  const startedAt = Date.now()
  const controller = options.controller ?? new SchedulerController()
  const log = options.onLog ?? (() => {})
  const targets = Array.from(new Set(options.targets)).filter(Boolean)
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 30))
  const concurrency = Math.min(3, Math.max(1, Math.floor(options.concurrency ?? 1)))
  const intervalMs = Math.max(0, options.intervalMs ?? 1000)
  const maxRequests = Math.max(1, Math.floor(options.maxRequests ?? 40))
  const retries = Math.max(0, Math.floor(options.retries ?? 2))
  const write = options.write !== false
  const backup = options.backup !== false
  const prune = options.prune ?? "off"
  const stamp = timestamp()

  const errors: string[] = []
  const failures: Record<string, FailedText[]> = {}

  const report: BatchReport = {
    ok: true,
    dir: options.dir,
    files: 0,
    targets,
    pendingBefore: 0,
    requests: 0,
    translated: 0,
    failed: 0,
    remaining: 0,
    pruned: 0,
    changedFiles: [],
    stoppedBy: "done",
    elapsedMs: 0,
    errors,
    filesSummary: [],
  }

  const files = await listFiles(options.dir, options.filter)
  report.files = files.length
  log(`scanning ${files.length} file(s) for ${targets.join(", ")}`)

  // ---- Pass A: totals only (cheap, discards parsed data) -----------------
  for (const file of files) {
    try {
      const { data } = await readData(file)
      const stale = new Set(findStaleKeys(data))
      for (const locale of targets) {
        if (locale === data.sourceLanguage) {
          continue
        }
        report.pendingBefore += findKeysToTranslate(data, locale).filter(key => !stale.has(key)).length
      }
    } catch (error) {
      errors.push(`${relativePath(options.dir, file)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  log(`pending ${report.pendingBefore} slot(s)`)

  // ---- File by file ------------------------------------------------------
  for (const file of files) {
    if (controller.isCancelled) {
      report.stoppedBy = "cancelled"
      break
    }
    if (report.requests >= maxRequests) {
      report.stoppedBy = "maxRequests"
      break
    }

    const rel = relativePath(options.dir, file)
    let raw: string
    let data: LocalizableData
    try {
      const loaded = await readData(file)
      raw = loaded.raw
      data = loaded.data
    } catch (error) {
      errors.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    const summary: BatchFileSummary = {
      path: rel,
      pending: 0,
      added: 0,
      replaced: 0,
      pruned: 0,
      requests: 0,
      failed: 0,
      changed: false,
    }

    const queue = buildFileTasks(data, targets, batchSize, new Set(findStaleKeys(data)))
    summary.pending = queue.reduce((sum, task) => sum + task.contents.length, 0)
    const results = new Map<string, string>()
    const fileFailures: FailedText[] = []
    let budgetHit = false

    while (queue.length > 0) {
      if (controller.isCancelled) {
        break
      }
      const budget = maxRequests - report.requests
      if (budget <= 0) {
        budgetHit = true
        break
      }
      const chunk = queue.splice(0, budget)
      report.requests += chunk.length
      summary.requests += chunk.length

      await runTasks<Task, string[] | null>(
        {
          tasks: chunk,
          concurrency,
          intervalMs,
          worker: async (task, signal) => {
            return translate({
              contents: task.contents,
              language: promptLanguage(task.locale),
              selection: options.selection,
              profile: "xcstrings",
              signal,
            })
          },
          onResult: (translations, task) => {
            if (!translations) {
              if (!controller.isCancelled && task.attempt < retries) {
                queue.push({ ...task, attempt: task.attempt + 1 })
              } else {
                task.contents.forEach(key => fileFailures.push({ locale: task.locale, key }))
              }
              return
            }
            translations.forEach((value, index) => {
              const key = task.contents[index]
              if (typeof value === "string" && value.length > 0) {
                results.set(`${task.locale}\u0000${key}`, value)
              } else if (task.attempt < retries) {
                queue.push({ locale: task.locale, contents: [key], attempt: task.attempt + 1 })
              } else {
                fileFailures.push({ locale: task.locale, key })
              }
            })
          },
          onError: (error, task) => {
            const message = error instanceof Error ? error.message : String(error)
            log(`[${rel}] ${task.locale} batch failed (attempt ${task.attempt + 1}): ${message}`)
            if (task.attempt < retries && task.contents.length > 1) {
              // Retry with smaller batches: long payloads are the usual cause.
              const size = Math.max(5, Math.ceil(task.contents.length / 2))
              for (let i = 0; i < task.contents.length; i += size) {
                queue.unshift({
                  locale: task.locale,
                  contents: task.contents.slice(i, i + size),
                  attempt: task.attempt + 1,
                })
              }
            } else {
              task.contents.forEach(key => fileFailures.push({ locale: task.locale, key }))
            }
          },
        },
        controller,
      )
    }

    // Unexpected returns (null translations / empty values) are failures too.
    if (fileFailures.length > 0) {
      failures[rel] = fileFailures
      summary.failed = fileFailures.length
      summary.failedSample = fileFailures.slice(0, FAILED_SAMPLE_LIMIT)
      report.failed += fileFailures.length
    }

    // Prune (stale entries) — independent of translation results.
    const removals: string[] = []
    if (prune === "all") {
      removals.push(...findStaleKeys(data))
    } else if (prune === "file") {
      const listed = options.pruneMap?.[rel] ?? []
      removals.push(...listed.filter(key => data.strings[key] != null))
    }
    const removalSet = new Set(removals)

    const insertions: Record<string, LocaleInsert[]> = {}
    const replacements: Record<string, LocaleInsert[]> = {}
    for (const locale of targets) {
      if (locale === data.sourceLanguage) {
        continue
      }
      for (const key of Object.keys(data.strings)) {
        if (removalSet.has(key) || !needsTranslation(data.strings[key], locale)) {
          continue
        }
        const value = results.get(`${locale}\u0000${key}`)
        if (value === undefined) {
          continue
        }
        if (data.strings[key].localizations?.[locale] != null) {
          const bucket = replacements[key] ?? []
          bucket.push({ locale, value })
          replacements[key] = bucket
        } else {
          const bucket = insertions[key] ?? []
          bucket.push({ locale, value })
          insertions[key] = bucket
        }
      }
    }

    const hasEdits =
      removals.length > 0 ||
      Object.keys(insertions).length > 0 ||
      Object.keys(replacements).length > 0

    if (hasEdits) {
      // Mutate the parsed copy to build the verification baseline.
      for (const key of removals) {
        delete data.strings[key]
      }
      const apply = (bucket: Record<string, LocaleInsert[]>) => {
        for (const key of Object.keys(bucket)) {
          const entry = data.strings[key]
          if (!entry) {
            continue
          }
          if (!entry.localizations) {
            entry.localizations = {}
          }
          for (const item of bucket[key]) {
            entry.localizations[item.locale] = {
              stringUnit: { state: "translated", value: item.value },
            }
          }
        }
      }
      apply(insertions)
      apply(replacements)

      let patched: string | null = null
      try {
        patched = patchXcstrings(raw, { insertions, replacements, removals })
      } catch (error) {
        summary.error = error instanceof Error ? error.message : String(error)
        errors.push(`${rel}: ${summary.error}`)
      }

      if (patched != null) {
        const verification = verifyPatch(data, patched)
        if (!verification.ok) {
          summary.error = verification.error ?? "verification failed"
          errors.push(`${rel}: ${summary.error}`)
        } else {
          summary.added = Object.values(insertions).reduce((sum, list) => sum + list.length, 0)
          summary.replaced = Object.values(replacements).reduce((sum, list) => sum + list.length, 0)
          summary.pruned = removals.length
          summary.changed = patched !== raw
          report.translated += summary.added + summary.replaced
          report.pruned += summary.pruned

          if (summary.changed && write) {
            try {
              if (backup) {
                await writeBackup(options.dir, stamp, file, raw)
              }
              await FileManager.writeAsString(file, patched)
              report.changedFiles.push(rel)
            } catch (error) {
              summary.error = error instanceof Error ? error.message : String(error)
              errors.push(`${rel}: ${summary.error}`)
            }
          }
        }
      }
    }

    report.filesSummary.push(summary)

    if (budgetHit) {
      report.stoppedBy = "maxRequests"
      break
    }
  }

  report.remaining = Math.max(0, report.pendingBefore - report.translated)
  if (report.stoppedBy === "done" && report.remaining > 0) {
    report.stoppedBy = "maxRequests"
  }
  if (!write) {
    report.stoppedBy = "writeDisabled"
  }
  report.ok = errors.length === 0
  report.elapsedMs = Date.now() - startedAt

  await persistReport(options, report, failures)

  log(
    `done: +${report.translated} translated, ${report.failed} failed, ${report.remaining} remaining, ${report.changedFiles.length} file(s) changed (${report.elapsedMs}ms)`,
  )
  return report
}

async function persistReport(
  options: BatchOptions,
  report: BatchReport,
  failures: Record<string, FailedText[]>,
): Promise<void> {
  if (options.reportPath) {
    try {
      await FileManager.writeAsString(options.reportPath, JSON.stringify(report, null, 2))
    } catch (error) {
      report.errors.push(`report: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (options.failedPath) {
    try {
      await FileManager.writeAsString(options.failedPath, JSON.stringify(failures, null, 2))
    } catch (error) {
      report.errors.push(`failed list: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
