import { SchedulerController } from "./scheduler"

/**
 * A single global FIFO queue for translation work.
 *
 * Only one job runs at a time so the UI and HTTP requests never compete for the
 * same provider rate limit. A job owns a SchedulerController, so pause/cancel
 * still work while the job is running.
 */

export class QueueFullError extends Error {
  constructor(message = "Translation queue is full") {
    super(message)
    this.name = "QueueFullError"
  }
}

export class JobCancelledError extends Error {
  constructor(message = "Translation job was cancelled") {
    super(message)
    this.name = "JobCancelledError"
  }
}

export type EnqueueOptions = {
  /** Stable id, e.g. `ui` or a jobId. Defaults to a random id. */
  id?: string
  /** Human-readable label for logs. */
  label?: string
  /** Reuse an existing controller (UI pause/cancel). */
  controller?: SchedulerController
  /** Pending limit override. Defaults to the queue limit. */
  maxPending?: number
}

export type QueueSnapshot = {
  busy: boolean
  runningId: string | null
  pending: number
  limit: number
}

type Entry<T> = {
  id: string
  label: string
  controller: SchedulerController
  runner: (controller: SchedulerController) => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
  cancelled: boolean
}

function randomId(): string {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export class TranslationQueue {
  private pending: Entry<any>[] = []
  private running: Entry<any> | null = null
  private limit: number

  constructor(limit = 8) {
    this.limit = limit
  }

  get snapshot(): QueueSnapshot {
    return {
      busy: this.running !== null,
      runningId: this.running?.id ?? null,
      pending: this.pending.length,
      limit: this.limit,
    }
  }

  get isBusy(): boolean {
    return this.running !== null
  }

  /**
   * Enqueue a job. Rejects with QueueFullError when the pending limit is hit,
   * or JobCancelledError when the job was cancelled before it started.
   */
  enqueue<T>(
    runner: (controller: SchedulerController) => Promise<T>,
    options: EnqueueOptions = {},
  ): Promise<T> {
    const limit = Math.max(1, Math.floor(options.maxPending ?? this.limit))
    if (this.pending.length >= limit) {
      throw new QueueFullError()
    }

    const id = options.id ?? randomId()
    const controller = options.controller ?? new SchedulerController()

    if (controller.isCancelled) {
      throw new JobCancelledError()
    }

    return new Promise<T>((resolve, reject) => {
      const entry: Entry<T> = {
        id,
        label: options.label ?? id,
        controller,
        runner,
        resolve,
        reject,
        cancelled: false,
      }
      this.pending.push(entry)
      this.pump()
    })
  }

  /** Cancel a queued or running job by id. Returns true when found. */
  cancel(id: string): boolean {
    const index = this.pending.findIndex(entry => entry.id === id)
    if (index >= 0) {
      const [entry] = this.pending.splice(index, 1)
      entry.cancelled = true
      entry.reject(new JobCancelledError())
      return true
    }
    if (this.running?.id === id) {
      this.running.controller.cancel()
      return true
    }
    return false
  }

  /** Cancel all queued jobs and the running one. */
  cancelAll(): void {
    const queued = this.pending
    this.pending = []
    queued.forEach(entry => {
      entry.cancelled = true
      entry.reject(new JobCancelledError())
    })
    this.running?.controller.cancel()
  }

  private pump(): void {
    if (this.running) {
      return
    }

    while (this.pending.length > 0) {
      const entry = this.pending.shift()!
      if (entry.cancelled || entry.controller.isCancelled) {
        entry.reject(new JobCancelledError())
        continue
      }

      this.running = entry
      Promise.resolve()
        .then(() => entry.runner(entry.controller))
        .then(result => entry.resolve(result))
        .catch(error => entry.reject(error))
        .finally(() => {
          this.running = null
          this.pump()
        })
      return
    }
  }
}

/** Global queue shared by the UI and HTTP server. */
export const translationQueue = new TranslationQueue(8)
