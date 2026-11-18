import { SchedulerController } from "../engine/scheduler"
import type { LocaleProgress } from "../engine/translation_service"

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"

export type JobType = "xcstrings"

export type JobSummary = {
  id: string
  type: JobType
  status: JobStatus
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  progress: Record<string, LocaleProgress>
  summary: Record<string, { total: number; done: number; failed: number }> | null
  error: string | null
}

export type JobRecord = JobSummary & {
  controller: SchedulerController
  result: string | null
  resultError: string | null
}

const MAX_JOBS = 20
const TTL_MS = 30 * 60 * 1000
const MAX_RESULT_CHARS = 20 * 1024 * 1024

function randomId(): string {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function summarize(
  progress: Record<string, LocaleProgress>,
): Record<string, { total: number; done: number; failed: number }> {
  const summary: Record<string, { total: number; done: number; failed: number }> = {}
  for (const [locale, item] of Object.entries(progress)) {
    summary[locale] = {
      total: item.total,
      done: item.done,
      failed: item.failed,
    }
  }
  return summary
}

class JobRegistry {
  private jobs = new Map<string, JobRecord>()
  private timer: ReturnType<typeof setInterval> | null = null

  create(type: JobType = "xcstrings"): JobRecord {
    this.cleanup()
    if (this.jobs.size >= MAX_JOBS) {
      this.evictOldestFinished()
    }
    const now = Date.now()
    const job: JobRecord = {
      id: randomId(),
      type,
      status: "queued",
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      progress: {},
      summary: null,
      error: null,
      controller: new SchedulerController(),
      result: null,
      resultError: null,
    }
    this.jobs.set(job.id, job)
    this.ensureTimer()
    return job
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id)
  }

  describe(id: string): JobSummary | undefined {
    const job = this.jobs.get(id)
    return job ? this.toSummary(job) : undefined
  }

  list(): JobSummary[] {
    return Array.from(this.jobs.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(job => this.toSummary(job))
  }

  markStarted(id: string): void {
    const job = this.jobs.get(id)
    if (!job || job.status === "cancelled") {
      return
    }
    job.status = "running"
    job.startedAt = job.startedAt ?? Date.now()
  }

  updateProgress(id: string, progress: Record<string, LocaleProgress>): void {
    const job = this.jobs.get(id)
    if (!job || job.status === "cancelled") {
      return
    }
    job.progress = { ...progress }
  }

  finish(
    id: string,
    status: JobStatus,
    error: string | null = null,
    result: string | null = null,
  ): void {
    const job = this.jobs.get(id)
    if (!job) {
      return
    }
    if (job.status === "cancelled") {
      job.finishedAt = job.finishedAt ?? Date.now()
      return
    }
    job.status = status
    job.error = error
    job.finishedAt = Date.now()
    job.summary = summarize(job.progress)
    if (result !== null) {
      if (result.length > MAX_RESULT_CHARS) {
        job.result = null
        job.resultError = "translated result is too large to keep in memory"
      } else {
        job.result = result
        job.resultError = null
      }
    }
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job || job.status === "completed" || job.status === "partial" || job.status === "failed" || job.status === "cancelled") {
      return false
    }
    job.controller.cancel()
    if (job.status === "queued") {
      job.status = "cancelled"
      job.finishedAt = Date.now()
    }
    return true
  }

  dispose(): void {
    this.jobs.clear()
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private ensureTimer(): void {
    if (this.timer !== null) {
      return
    }
    this.timer = setInterval(() => this.cleanup(), 60 * 1000)
  }

  private cleanup(): void {
    const cutoff = Date.now() - TTL_MS
    for (const [id, job] of this.jobs) {
      if (job.finishedAt !== null && job.finishedAt < cutoff) {
        this.jobs.delete(id)
      }
    }
  }

  private evictOldestFinished(): void {
    let oldest: JobRecord | null = null
    for (const job of this.jobs.values()) {
      if (job.finishedAt === null) {
        continue
      }
      if (!oldest || job.finishedAt < (oldest.finishedAt ?? 0)) {
        oldest = job
      }
    }
    if (oldest) {
      this.jobs.delete(oldest.id)
    }
  }

  private toSummary(job: JobRecord): JobSummary {
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
}

export const jobRegistry = new JobRegistry()
