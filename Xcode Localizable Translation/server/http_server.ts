/**
 * HTTP server lifecycle: start/stop, LAN address discovery, request log,
 * keep-alive ownership and cleanup. Routes live in routes.ts.
 */

import { Script } from "scripting"
import { registerRoutes, RequestLogEntry, MAX_REQUEST_BYTES } from "./routes"
import { jobRegistry } from "./job_registry"
import { translationQueue } from "../engine/job_queue"
import * as keepAlive from "../engine/keep_alive"

export type ServerState = "stopped" | "starting" | "running" | "stopping" | "error"

export type ServerSnapshot = {
  state: ServerState
  port: number | null
  urls: string[]
  startedAt: number | null
  lastError: string | null
  requests: RequestLogEntry[]
  standalone: boolean
  queue: {
    busy: boolean
    runningId: string | null
    pending: number
    limit: number
  }
}

const MAX_LOG_ENTRIES = 20

/** Collect LAN-reachable IPv4 base URLs, preferring the Wi-Fi interface. */
function lanUrls(port: number): string[] {
  const urls: string[] = []
  try {
    const interfaces = Device.networkInterfaces()
    const names = Object.keys(interfaces).sort((a, b) => {
      if (a === "en0") return -1
      if (b === "en0") return 1
      return a.localeCompare(b)
    })
    for (const name of names) {
      for (const item of interfaces[name] ?? []) {
        if (item.family !== "IPv4" || item.isInternal) {
          continue
        }
        if (item.address === "127.0.0.1" || item.address.startsWith("169.254.")) {
          continue
        }
        const url = `http://${item.address}:${port}`
        if (!urls.includes(url)) {
          urls.push(url)
        }
      }
    }
  } catch (error) {
    console.error("Failed to read network interfaces", error)
  }
  return urls
}

class TranslationHttpServer {
  private server: HttpServer | null = null
  private state: ServerState = "stopped"
  private port: number | null = null
  private urls: string[] = []
  private startedAt: number | null = null
  private lastError: string | null = null
  private requests: RequestLogEntry[] = []
  private listeners = new Set<() => void>()
  private keepAliveOptions = { keepAlive: true, wakeLock: false }
  private standalone = false

  get snapshot(): ServerSnapshot {
    return {
      state: this.state,
      port: this.port,
      urls: [...this.urls],
      startedAt: this.startedAt,
      lastError: this.lastError,
      requests: [...this.requests],
      standalone: this.standalone,
      queue: translationQueue.snapshot,
    }
  }

  get isRunning(): boolean {
    return this.state === "running" && this.server !== null
  }

  /** Headless instances exit after an external shutdown request. */
  setStandalone(value: boolean): void {
    this.standalone = value
    this.emit()
  }

  get isStandalone(): boolean {
    return this.standalone
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  recordRequest(entry: RequestLogEntry): void {
    this.requests.unshift(entry)
    if (this.requests.length > MAX_LOG_ENTRIES) {
      this.requests.length = MAX_LOG_ENTRIES
    }
    this.emit()
  }

  async start(
    port: number,
    options: { keepAlive?: boolean; wakeLock?: boolean } = {},
  ): Promise<string | null> {
    if (this.state === "running" || this.state === "starting") {
      return null
    }

    this.state = "starting"
    this.lastError = null
    this.keepAliveOptions = {
      keepAlive: options.keepAlive !== false,
      wakeLock: options.wakeLock === true,
    }
    this.emit()

    const server = new HttpServer()
    server.listenAddressIPv4 = "0.0.0.0"

    let error: string | null = null
    try {
      registerRoutes(server, {
        logRequest: entry => this.recordRequest(entry),
        getRuntime: () => ({
          state: this.state,
          port: this.port,
          startedAt: this.startedAt,
          standalone: this.standalone,
        }),
        shutdown: () => this.scheduleShutdown(),
      })
      error = server.start({
        port,
        forceIPv4: true,
        maxRequestBodySize: MAX_REQUEST_BYTES,
      })
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }

    if (error) {
      this.server = null
      this.state = "error"
      this.lastError = error
      this.port = null
      this.urls = []
      this.startedAt = null
      this.emit()
      return error
    }

    this.server = server
    this.state = "running"
    this.port = server.port ?? port
    this.startedAt = Date.now()
    this.urls = lanUrls(this.port)
    await keepAlive.acquire("server", this.keepAliveOptions)
    this.emit()
    return null
  }

  async stop(): Promise<void> {
    if (this.server === null && this.state === "stopped") {
      await keepAlive.release("server")
      return
    }

    this.state = "stopping"
    this.emit()

    // Cancel only HTTP jobs; a UI translation may be running independently.
    for (const job of jobRegistry.list()) {
      if (job.status === "queued" || job.status === "running") {
        translationQueue.cancel(job.id)
        jobRegistry.cancel(job.id)
      }
    }
    jobRegistry.dispose()

    try {
      this.server?.stop()
    } catch (error) {
      console.error("Failed to stop HTTP server", error)
    }

    this.server = null
    this.port = null
    this.urls = []
    this.startedAt = null
    this.state = "stopped"
    await keepAlive.release("server")
    this.emit()
  }

  async updateKeepAlive(options: {
    keepAlive?: boolean
    wakeLock?: boolean
  }): Promise<void> {
    this.keepAliveOptions = {
      keepAlive: options.keepAlive !== false,
      wakeLock: options.wakeLock === true,
    }
    if (this.isRunning) {
      await keepAlive.acquire("server", this.keepAliveOptions)
    }
  }

  private scheduleShutdown(): void {
    // Let the HTTP response flush before tearing the listener down.
    setTimeout(() => {
      void this.stop().finally(() => {
        if (this.standalone) {
          Script.exit({ ok: true, stopped: true })
        }
      })
    }, 50)
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.error("HTTP server listener failed", error)
      }
    }
  }
}

export const translationHttpServer = new TranslationHttpServer()
