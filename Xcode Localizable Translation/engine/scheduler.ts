/**
 * Scheduler: a pausable / cancellable / concurrent task runner with global throttling.
 *
 * - Concurrency: up to `concurrency` workers run tasks in parallel.
 * - Global throttle: at most one task may *start* per `intervalMs` window across ALL
 *   workers (a shared gate), so increasing concurrency does not bypass the interval.
 * - Pause/Resume: workers check the pause gate between tasks; when paused they await
 *   a promise that resolves on resume.
 * - Cancel: sets a flag; in-flight tasks finish (cooperatively if they read the signal),
 *   no new tasks are started.
 */

export type SchedulerSignal = {
  /** Returns true when the run has been cancelled. */
  readonly isCancelled: boolean
}

export type SchedulerControl = {
  pause(): void
  resume(): void
  cancel(): void
  readonly isPaused: boolean
  readonly isCancelled: boolean
}

export type RunTasksOptions<T, R> = {
  tasks: T[]
  concurrency: number
  intervalMs: number
  /** Executes a single task. Receives the signal so it can abort cooperatively. */
  worker: (task: T, signal: SchedulerSignal) => Promise<R>
  onResult?: (result: R, task: T, index: number) => void
  onError?: (error: unknown, task: T, index: number) => void
}

/**
 * A controller that owns the mutable pause/cancel state and exposes a gate
 * that callers (and the scheduler) can await.
 */
export class SchedulerController implements SchedulerControl, SchedulerSignal {
  private _paused = false
  private _cancelled = false
  private _resumeWaiters: Array<() => void> = []
  /** Timestamp (ms) when the next task is allowed to start. */
  private _nextSlot = 0

  get isPaused() {
    return this._paused
  }

  get isCancelled() {
    return this._cancelled
  }

  pause() {
    this._paused = true
  }

  resume() {
    if (!this._paused) {
      return
    }
    this._paused = false
    const waiters = this._resumeWaiters
    this._resumeWaiters = []
    waiters.forEach(fn => fn())
  }

  cancel() {
    this._cancelled = true
    // Wake any paused waiters so they can observe cancellation and exit.
    const waiters = this._resumeWaiters
    this._resumeWaiters = []
    waiters.forEach(fn => fn())
  }

  /** Resolves immediately if running; otherwise resolves on resume/cancel. */
  async waitWhilePaused(): Promise<void> {
    if (!this._paused || this._cancelled) {
      return
    }
    await new Promise<void>(resolve => {
      this._resumeWaiters.push(resolve)
    })
  }

  /**
   * Reserve the next global throttle slot. Returns the delay (ms) the caller
   * should wait before starting its task. Reserving advances the shared cursor
   * so concurrent workers are spaced by `intervalMs`.
   */
  reserveSlot(intervalMs: number): number {
    const now = Date.now()
    const start = Math.max(now, this._nextSlot)
    this._nextSlot = start + Math.max(0, intervalMs)
    return start - now
  }

  resetThrottle() {
    this._nextSlot = 0
  }

  /** Clear cancel/pause state so the controller can be reused for a new run. */
  reset() {
    this._cancelled = false
    this._paused = false
    this._resumeWaiters = []
    this._nextSlot = 0
  }
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Runs `tasks` through a worker pool. Resolves when all tasks are done,
 * cancelled, or have errored (errors are routed to onError, not thrown).
 */
export async function runTasks<T, R>(
  options: RunTasksOptions<T, R>,
  controller: SchedulerController,
): Promise<void> {
  const { tasks, worker, onResult, onError } = options
  const concurrency = Math.max(1, Math.floor(options.concurrency))
  const intervalMs = Math.max(0, options.intervalMs)

  let cursor = 0

  const runWorker = async () => {
    while (true) {
      if (controller.isCancelled) {
        return
      }

      // Honor pause between tasks.
      await controller.waitWhilePaused()
      if (controller.isCancelled) {
        return
      }

      const index = cursor++
      if (index >= tasks.length) {
        return
      }
      const task = tasks[index]

      // Global throttle: space out task starts across all workers.
      const wait = controller.reserveSlot(intervalMs)
      if (wait > 0) {
        await delay(wait)
      }
      if (controller.isCancelled) {
        return
      }
      // Re-check pause after throttle wait.
      await controller.waitWhilePaused()
      if (controller.isCancelled) {
        return
      }

      try {
        const result = await worker(task, controller)
        if (!controller.isCancelled) {
          onResult?.(result, task, index)
        }
      } catch (e) {
        if (!controller.isCancelled) {
          onError?.(e, task, index)
        }
      }
    }
  }

  const workers: Promise<void>[] = []
  const poolSize = Math.min(concurrency, Math.max(1, tasks.length))
  for (let i = 0; i < poolSize; i++) {
    workers.push(runWorker())
  }
  await Promise.all(workers)
}
