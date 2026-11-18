/**
 * HTTP API implementation.
 *
 * Routes are intentionally thin: validation and status codes live here, while
 * batching/deduplication/throttling live in engine/translation_service.ts.
 */

import { loadSettings, TranslationSettings } from "../store"
import {
  LANGUAGES,
  LOCALE_ALIASES,
  canonicalLocale,
  toLanguage,
  Language,
} from "../languages"
import {
  translationQueue,
  QueueFullError,
  JobCancelledError,
} from "../engine/job_queue"
import {
  translateTexts,
  translateXcstrings,
  resolveProviderSelection,
  ProviderNotConfiguredError,
} from "../engine/translation_service"
import type { LocaleProgress } from "../engine/translation_service"
import { isLocalizableData, LocalizableData } from "../xcstrings_util"
import { jobRegistry, JobSummary } from "./job_registry"

const API_VERSION = "1.0.0"
const MAX_TEXTS = 500
const MAX_TOTAL_CHARS = 100_000
const MAX_REQUEST_BYTES = 20 * 1024 * 1024

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Target-Locales",
  "Access-Control-Max-Age": "86400",
}

export type RequestLogEntry = {
  at: number
  method: string
  path: string
  status: number
  durationMs: number
  address: string | null
}

export type RouteRuntime = {
  state: string
  port: number | null
  startedAt: number | null
  standalone: boolean
}

export type RouteContext = {
  logRequest: (entry: RequestLogEntry) => void
  getRuntime: () => RouteRuntime
  shutdown: () => void
}

class HttpError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly details?: unknown

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = "HttpError"
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}

function reasonPhrase(status: number): string {
  switch (status) {
    case 200: return "OK"
    case 202: return "Accepted"
    case 204: return "No Content"
    case 400: return "Bad Request"
    case 404: return "Not Found"
    case 405: return "Method Not Allowed"
    case 409: return "Conflict"
    case 413: return "Payload Too Large"
    case 415: return "Unsupported Media Type"
    case 429: return "Too Many Requests"
    case 500: return "Internal Server Error"
    case 502: return "Bad Gateway"
    default: return "OK"
  }
}

function encodeBody(text: string): Data {
  const data = Data.fromString(text)
  if (!data) {
    throw new Error("Failed to encode response body")
  }
  return data
}

function jsonResponse(
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): HttpResponse {
  const body = encodeBody(JSON.stringify(payload))
  return HttpResponse.raw(status, reasonPhrase(status), {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
    body,
  })
}

function textResponse(
  status: number,
  text: string,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): HttpResponse {
  const body = encodeBody(text)
  return HttpResponse.raw(status, reasonPhrase(status), {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": contentType,
      ...extraHeaders,
    },
    body,
  })
}

function emptyResponse(status: number): HttpResponse {
  return HttpResponse.raw(status, reasonPhrase(status), {
    headers: { ...CORS_HEADERS },
  })
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): HttpResponse {
  return jsonResponse(status, {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mapError(error: unknown): HttpResponse {
  if (error instanceof HttpError) {
    return errorResponse(error.statusCode, error.code, error.message, error.details)
  }
  if (error instanceof ProviderNotConfiguredError) {
    return errorResponse(502, "provider_not_configured", error.message)
  }
  if (error instanceof QueueFullError) {
    return jsonResponse(
      429,
      { ok: false, error: { code: "queue_full", message: error.message } },
      { "Retry-After": "5" },
    )
  }
  if (error instanceof JobCancelledError) {
    return errorResponse(409, "job_cancelled", error.message)
  }
  console.error("HTTP handler error:", error)
  return errorResponse(500, "internal_error", "Internal server error")
}

function readBody(req: HttpRequest): string {
  try {
    if (!req.body) {
      return ""
    }
    return req.body.toRawString("utf-8") ?? ""
  } catch (error) {
    throw new HttpError(400, "invalid_body", `Unable to read request body: ${messageOf(error)}`)
  }
}

function requireJsonContentType(req: HttpRequest): void {
  const contentType = (req.headers["content-type"] ?? "").toLowerCase()
  if (
    contentType.length > 0
    && !contentType.includes("application/json")
    && !contentType.includes("text/plain")
  ) {
    throw new HttpError(
      415,
      "unsupported_media_type",
      "Use Content-Type: application/json",
    )
  }
}

function parseJsonBody(req: HttpRequest): any {
  requireJsonContentType(req)
  const text = readBody(req)
  if (!text.trim()) {
    throw new HttpError(400, "invalid_json", "Request body is empty")
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new HttpError(400, "invalid_json", `Invalid JSON: ${messageOf(error)}`)
  }
}

function queryValues(req: HttpRequest, key: string): string[] {
  const values: string[] = []
  for (const item of req.queryParams) {
    if (item.key !== key) {
      continue
    }
    for (const part of item.value.split(",")) {
      const value = part.trim()
      if (value) {
        values.push(value)
      }
    }
  }
  return values
}

function queryValue(req: HttpRequest, key: string): string | null {
  const item = req.queryParams.find(entry => entry.key === key)
  return item ? item.value : null
}

function isTruthy(value: string | null): boolean {
  return value === "" || value === "1" || value?.toLowerCase() === "true"
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function normalizeTargets(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : []
  const result: string[] = []
  for (const item of raw) {
    if (typeof item !== "string") {
      continue
    }
    const locale = canonicalLocale(item)
    if (locale && !result.includes(locale)) {
      result.push(locale)
    }
  }
  return result
}

function collectLocales(req: HttpRequest, settings: TranslationSettings): string[] {
  let values = queryValues(req, "locales")
  if (values.length === 0) {
    values = queryValues(req, "locale")
  }
  if (values.length === 0) {
    const header = req.headers["x-target-locales"]
    if (header) {
      values = header.split(",")
    }
  }
  if (values.length === 0) {
    values = settings.locales
  }
  const result: string[] = []
  for (const value of values) {
    const locale = canonicalLocale(value)
    if (locale && !result.includes(locale)) {
      result.push(locale)
    }
  }
  return result
}

function summarizeProgress(
  progress: Record<string, LocaleProgress>,
): Record<string, { total: number; done: number; failed: number }> {
  const summary: Record<string, { total: number; done: number; failed: number }> = {}
  for (const [locale, item] of Object.entries(progress)) {
    summary[locale] = { total: item.total, done: item.done, failed: item.failed }
  }
  return summary
}

function totals(progress: Record<string, LocaleProgress>): {
  done: number
  failed: number
  total: number
} {
  let done = 0
  let failed = 0
  let total = 0
  for (const item of Object.values(progress)) {
    done += item.done
    failed += item.failed
    total += item.total
  }
  return { done, failed, total }
}

function statusOf(progress: Record<string, LocaleProgress>): "completed" | "partial" {
  return Object.values(progress).some(item => item.failed > 0) ? "partial" : "completed"
}

/** Keep response header values ASCII-safe. */
function asciiHeader(value: string): string {
  return /^[\x20-\x7E]*$/.test(value) ? value : encodeURIComponent(value)
}

function jobPayload(job: JobSummary): Record<string, unknown> {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: job.progress,
    summary: job.summary,
    error: job.error,
  }
}

async function handleHealth(
  _req: HttpRequest,
  context: RouteContext,
): Promise<HttpResponse> {
  const settings = loadSettings()
  const runtime = context.getRuntime()
  return jsonResponse(200, {
    ok: true,
    app: "xcstrings-translation",
    version: API_VERSION,
    state: runtime.state,
    port: runtime.port,
    standalone: runtime.standalone,
    uptimeMs: runtime.startedAt === null ? 0 : Date.now() - runtime.startedAt,
    busy: translationQueue.isBusy,
    queued: translationQueue.snapshot.pending,
    provider: settings.providerKey,
    model: settings.modelId,
  })
}

async function handleLanguages(): Promise<HttpResponse> {
  return jsonResponse(200, {
    ok: true,
    languages: LANGUAGES.map(item => ({ locale: item.locale, name: item.name })),
    aliases: LOCALE_ALIASES,
  })
}

async function handleTranslate(req: HttpRequest): Promise<HttpResponse> {
  const settings = loadSettings()
  const body = parseJsonBody(req)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_request", "Body must be a JSON object")
  }

  const rawTexts = Array.isArray(body.texts)
    ? body.texts
    : typeof body.text === "string"
      ? [body.text]
      : null
  if (!rawTexts || rawTexts.length === 0) {
    throw new HttpError(400, "invalid_request", "`texts` must be a non-empty array")
  }
  if (rawTexts.length > MAX_TEXTS) {
    throw new HttpError(400, "invalid_request", `At most ${MAX_TEXTS} texts are allowed`)
  }
  if (!rawTexts.every((item: unknown) => typeof item === "string")) {
    throw new HttpError(400, "invalid_request", "Every item in `texts` must be a string")
  }
  const texts = rawTexts as string[]
  const totalChars = texts.reduce((sum, item) => sum + item.length, 0)
  if (totalChars > MAX_TOTAL_CHARS) {
    throw new HttpError(
      400,
      "invalid_request",
      `Total text length must be <= ${MAX_TOTAL_CHARS} characters`,
    )
  }

  const targets = normalizeTargets(body.targets ?? body.target)
  if (targets.length === 0) {
    throw new HttpError(400, "invalid_request", "`targets` must contain at least one locale")
  }

  const profile = body.profile
  if (profile !== undefined && profile !== "plain" && profile !== "xcstrings") {
    throw new HttpError(400, "invalid_request", "`profile` must be `plain` or `xcstrings`")
  }

  const context = typeof body.context === "string" ? body.context : undefined
  const source = typeof body.source === "string" ? body.source : undefined
  const batchSize = numberField(body.batchSize)
  const concurrency = numberField(body.concurrency)
  const intervalMs = numberField(body.intervalMs)

  const result = await translationQueue.enqueue(
    async controller => {
      const { selection } = await resolveProviderSelection(settings)
      return translateTexts({
        texts,
        targets,
        source,
        profile: profile ?? "plain",
        context,
        selection,
        batchSize,
        concurrency,
        intervalMs,
        controller,
      })
    },
    { label: "http-translate" },
  )

  if (result.stats.done === 0 && result.stats.failed > 0) {
    throw new HttpError(502, "provider_failed", "All translation batches failed")
  }

  const partial = Object.values(result.failed).some(indexes => indexes.length > 0)
  return jsonResponse(200, {
    ok: true,
    partial,
    results: result.results,
    failed: result.failed,
    stats: result.stats,
  })
}

async function handleXcstrings(req: HttpRequest): Promise<HttpResponse> {
  requireJsonContentType(req)
  const raw = readBody(req)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new HttpError(400, "invalid_json", `Invalid JSON: ${messageOf(error)}`)
  }
  if (!isLocalizableData(parsed)) {
    throw new HttpError(400, "invalid_request", "Body must be a Localizable.xcstrings object")
  }
  const data = parsed as LocalizableData
  const settings = loadSettings()
  const locales = collectLocales(req, settings)
  if (locales.length === 0) {
    throw new HttpError(400, "invalid_request", "No target locale was provided")
  }
  const languages: Language[] = locales.map(toLanguage)

  const asyncMode = isTruthy(queryValue(req, "async"))
  const batchSize = settings.batchSize
  const concurrency = settings.concurrency
  const intervalMs = settings.intervalMs

  if (asyncMode) {
    const job = jobRegistry.create("xcstrings")
    let promise: Promise<Record<string, LocaleProgress>>
    try {
      promise = translationQueue.enqueue(
        async controller => {
          jobRegistry.markStarted(job.id)
          try {
            const { selection } = await resolveProviderSelection(settings)
            const progress = await translateXcstrings({
              data,
              languages,
              selection,
              concurrency,
              intervalMs,
              batchSize,
              controller,
              onProgress: value => jobRegistry.updateProgress(job.id, value),
            })
            const result = totals(progress)
            if (result.done === 0 && result.failed > 0) {
              jobRegistry.finish(job.id, "failed", "All translation batches failed", null)
            } else {
              jobRegistry.finish(
                job.id,
                statusOf(progress),
                null,
                JSON.stringify(data, null, 2),
              )
            }
            return progress
          } catch (error) {
            const cancelled = controller.isCancelled
            jobRegistry.finish(
              job.id,
              cancelled ? "cancelled" : "failed",
              cancelled ? null : messageOf(error),
            )
            throw error
          }
        },
        { id: job.id, label: `http-xcstrings-${job.id}`, controller: job.controller },
      )
    } catch (error) {
      jobRegistry.finish(job.id, "failed", messageOf(error))
      throw error
    }
    promise.catch(() => {
      // Registry state is already updated in the runner.
    })
    return jsonResponse(202, { ok: true, jobId: job.id })
  }

  const progress = await translationQueue.enqueue(
    async controller => {
      const { selection } = await resolveProviderSelection(settings)
      return translateXcstrings({
        data,
        languages,
        selection,
        concurrency,
        intervalMs,
        batchSize,
        controller,
      })
    },
    { label: "http-xcstrings" },
  )

  const result = totals(progress)
  if (result.done === 0 && result.failed > 0) {
    throw new HttpError(502, "provider_failed", "All translation batches failed")
  }

  return textResponse(
    200,
    JSON.stringify(data, null, 2),
    "application/json; charset=utf-8",
    {
      "X-Translation-Status": statusOf(progress),
      "X-Translation-Summary": asciiHeader(JSON.stringify(summarizeProgress(progress))),
    },
  )
}

async function handleShutdown(
  _req: HttpRequest,
  context: RouteContext,
): Promise<HttpResponse> {
  context.shutdown()
  return jsonResponse(202, { ok: true, stopping: true })
}

async function handleListJobs(): Promise<HttpResponse> {
  return jsonResponse(200, { ok: true, jobs: jobRegistry.list() })
}

async function handleGetJob(req: HttpRequest): Promise<HttpResponse> {
  const id = req.params["id"]
  const job = jobRegistry.describe(id)
  if (!job) {
    throw new HttpError(404, "job_not_found", `Unknown job: ${id}`)
  }
  return jsonResponse(200, { ok: true, job: jobPayload(job) })
}

async function handleJobResult(req: HttpRequest): Promise<HttpResponse> {
  const id = req.params["id"]
  const job = jobRegistry.get(id)
  if (!job) {
    throw new HttpError(404, "job_not_found", `Unknown job: ${id}`)
  }
  if (job.controller.isCancelled) {
    throw new HttpError(409, "job_cancelled", "Job was cancelled")
  }
  if (job.status === "queued" || job.status === "running") {
    throw new HttpError(409, "job_not_ready", "Job has not finished yet")
  }
  if (job.status === "cancelled") {
    throw new HttpError(409, "job_cancelled", "Job was cancelled")
  }
  if (job.status === "failed") {
    throw new HttpError(502, "provider_failed", job.error ?? "Job failed")
  }
  if (!job.result) {
    throw new HttpError(
      500,
      "result_unavailable",
      job.resultError ?? "Job result is no longer available",
    )
  }
  return textResponse(
    200,
    job.result,
    "application/json; charset=utf-8",
    {
      "X-Translation-Status": job.status,
      "X-Translation-Summary": asciiHeader(JSON.stringify(job.summary ?? {})),
    },
  )
}

async function handleCancelJob(req: HttpRequest): Promise<HttpResponse> {
  const id = req.params["id"]
  const job = jobRegistry.get(id)
  if (!job) {
    throw new HttpError(404, "job_not_found", `Unknown job: ${id}`)
  }
  if (job.status !== "queued" && job.status !== "running") {
    throw new HttpError(409, "job_finished", `Job is already ${job.status}`)
  }
  jobRegistry.cancel(id)
  translationQueue.cancel(id)
  return jsonResponse(200, { ok: true, id, status: "cancelled" })
}

export function registerRoutes(server: HttpServer, context: RouteContext): void {
  // HttpServer stores one handler per path, so methods for the same path must
  // be dispatched inside a single handler.
  const route = (
    path: string,
    handlers: Record<string, (req: HttpRequest) => Promise<HttpResponse>>,
  ) => {
    const methods = Object.keys(handlers)
    server.registerAsyncHandler(path, async req => {
      const started = Date.now()
      let response: HttpResponse
      if (req.method === "OPTIONS") {
        response = emptyResponse(204)
      } else {
        const handler = handlers[req.method]
        if (!handler) {
          response = jsonResponse(
            405,
            {
              ok: false,
              error: {
                code: "method_not_allowed",
                message: `Use ${methods.join(" or ")} for ${path}`,
              },
            },
            { Allow: methods.join(", ") },
          )
        } else {
          try {
            response = await handler(req)
          } catch (error) {
            response = mapError(error)
          }
        }
      }
      context.logRequest({
        at: Date.now(),
        method: req.method,
        path: req.path,
        status: response.statusCode,
        durationMs: Date.now() - started,
        address: req.address ?? null,
      })
      return response
    })
  }

  route("/v1/health", { GET: req => handleHealth(req, context) })
  route("/v1/languages", { GET: () => handleLanguages() })
  route("/v1/translate", { POST: handleTranslate })
  route("/v1/xcstrings", { POST: handleXcstrings })
  route("/v1/jobs", { GET: () => handleListJobs() })
  route("/v1/jobs/:id/result", { GET: handleJobResult })
  route("/v1/jobs/:id", { GET: handleGetJob, DELETE: handleCancelJob })
  route("/v1/shutdown", { POST: req => handleShutdown(req, context) })

  server.setNotFoundHandler(async req => {
    if (req.method === "OPTIONS") {
      return emptyResponse(204)
    }
    context.logRequest({
      at: Date.now(),
      method: req.method,
      path: req.path,
      status: 404,
      durationMs: 0,
      address: req.address ?? null,
    })
    return errorResponse(404, "not_found", `No route: ${req.path}`)
  })
}

export { API_VERSION, MAX_REQUEST_BYTES }
