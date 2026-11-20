/**
 * Headless entry for `mode=batch`.
 *
 * Intended to be driven by the agent:
 *
 *   scripting-ts project "Xcode Localizable Translation" \
 *     --queryparameters '{"mode":"batch","dir":"/path/to/tmp","targets":"zh-Hans"}' \
 *     --timeout 900
 *
 * The provider/model always come from persisted settings (same as the UI), and
 * the report is written next to the working directory as `.batch-report.json`.
 */

import { Script } from "scripting"
import { loadSettings } from "../store"
import { canonicalLocale } from "../languages"
import { runBatch, BatchPruneMode, BatchReport } from "./batch"
import { resolveProviderSelection } from "./translation_service"

type Params = Record<string, any>

function stringParam(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value.trim()
  }
  if (typeof value === "number") {
    return String(value)
  }
  return fallback
}

function boolParam(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value
  }
  if (typeof value === "number") {
    return value !== 0
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (normalized === "1" || normalized === "true" || normalized === "yes") {
      return true
    }
    if (normalized === "0" || normalized === "false" || normalized === "no") {
      return false
    }
  }
  return fallback
}

function numberParam(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback
}

function localeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(item => canonicalLocale(String(item))).filter(Boolean)
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map(item => canonicalLocale(item.trim()))
      .filter(Boolean)
  }
  return []
}

export function isBatchMode(params: Params): boolean {
  const mode = stringParam(params.mode).toLowerCase()
  return mode === "batch" || mode === "translate-dir" || mode === "sync"
}

async function loadPruneMap(path: string): Promise<Record<string, string[]>> {
  if (!path) {
    return {}
  }
  if (!(await FileManager.exists(path))) {
    throw new Error(`prune file not found: ${path}`)
  }
  const raw = await FileManager.readAsString(path)
  const parsed = JSON.parse(raw) as Record<string, string[]>
  const map: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(parsed ?? {})) {
    if (Array.isArray(value)) {
      map[key] = value.map(item => String(item))
    }
  }
  return map
}

/** Run one chunk and exit with the report as the script result. */
export async function runBatchMode(params: Params): Promise<void> {
  const dir = stringParam(params.dir)
  if (!dir) {
    Script.exit({ ok: false, error: 'mode=batch requires a "dir" parameter' })
    return
  }

  const settings = loadSettings()
  const targets = localeList(params.targets).length > 0
    ? localeList(params.targets)
    : settings.locales.map(canonicalLocale)

  const pruneRaw = stringParam(params.prune, "off").toLowerCase()
  const prune: BatchPruneMode =
    pruneRaw === "all" || pruneRaw === "file" ? (pruneRaw as BatchPruneMode) : "off"

  let report: BatchReport
  try {
    const pruneMap = prune === "file" ? await loadPruneMap(stringParam(params.pruneFile)) : {}
    const { selection } = await resolveProviderSelection(settings)
    report = await runBatch({
      dir,
      targets,
      selection,
      prune,
      pruneMap,
      write: boolParam(params.write, true),
      backup: boolParam(params.backup, true),
      maxRequests: numberParam(params.maxRequests, 40),
      retries: numberParam(params.retries, 2),
      batchSize: numberParam(params.batchSize, settings.batchSize),
      concurrency: numberParam(params.concurrency, 1),
      intervalMs: numberParam(params.intervalMs, 1000),
      filter: stringParam(params.filter) || undefined,
      reportPath: stringParam(params.reportPath, `${dir}/.batch-report.json`),
      failedPath: stringParam(params.failedFile, `${dir}/.batch-failed.json`),
      onLog: message => console.log(message),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    Script.exit({ ok: false, error: message })
    return
  }

  Script.exit(report)
}
