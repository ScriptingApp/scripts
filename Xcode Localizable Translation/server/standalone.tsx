/**
 * Headless server mode.
 *
 * index.tsx enters this module when launched with `mode=server` (usually via
 * Script.run). It starts the HTTP server without presenting any UI, detects an
 * existing server on the same port, and presents the status page on resume.
 */

import { Navigation, NavigationStack, Script, useState } from "scripting"
import { loadSettings, saveSettings, TranslationSettings } from "../store"
import { translationHttpServer } from "./http_server"
import { isOwnServerRunning, requestShutdown } from "./client"
import { ServerPage } from "../components/ServerPage"

type Params = Record<string, any>

type ResumeDetails = {
  queryParameters?: Record<string, any> | null
  resumeFromMinimized?: boolean
}

type ServerOptions = {
  port: number
  keepAlive: boolean
  wakeLock: boolean
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

function portParam(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  const port = Math.floor(parsed)
  return port >= 1024 && port <= 65535 ? port : fallback
}

function stringParam(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}

export function isServerMode(params: Params): boolean {
  const mode = stringParam(params.mode)
  if (mode === "server" || mode === "headless") {
    return true
  }
  return boolParam(params.server, false)
}

let presenting = false

function StandaloneServerApp({
  onStopped,
  options,
}: {
  onStopped: () => void
  options: ServerOptions
}) {
  const [settings, setSettings] = useState<TranslationSettings>(() => ({
    ...loadSettings(),
    serverPort: options.port,
    serverKeepAlive: options.keepAlive,
    serverKeepScreenOn: options.wakeLock,
  }))

  const updateSettings = (patch: Partial<TranslationSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch }
      saveSettings(next)
      return next
    })
  }

  return (
    <ServerPage
      settings={settings}
      updateSettings={updateSettings}
      log={message => console.log(message)}
      standalone
      onStopped={onStopped}
    />
  )
}

async function presentStatusPage(options: ServerOptions): Promise<void> {
  if (presenting || Script.isMinimized()) {
    return
  }
  presenting = true
  try {
    await Navigation.present({
      element: (
        <NavigationStack>
          <StandaloneServerApp
            options={options}
            onStopped={() => Script.exit({ ok: true, stopped: true })}
          />
        </NavigationStack>
      ),
      modalPresentationStyle: "overFullScreen",
      swipeBackBehavior: "minimize",
    })
  } catch (error) {
    console.error("Failed to present the standalone server page", error)
  } finally {
    presenting = false
  }
}

async function stopServer(port: number): Promise<void> {
  if (translationHttpServer.isRunning) {
    await translationHttpServer.stop()
    return
  }
  if (await isOwnServerRunning(port)) {
    await requestShutdown(port)
  }
}

async function startServer(options: ServerOptions): Promise<string | null> {
  translationHttpServer.setStandalone(true)
  return translationHttpServer.start(options.port, {
    keepAlive: options.keepAlive,
    wakeLock: options.wakeLock,
  })
}

async function handleResume(
  details: ResumeDetails,
  options: ServerOptions,
): Promise<void> {
  console.log("standalone server resume:", JSON.stringify(details))
  const action = stringParam(details.queryParameters?.action)

  if (action === "stop") {
    await stopServer(options.port)
    Script.exit({ ok: true, stopped: true })
    return
  }

  if (!translationHttpServer.isRunning) {
    if (await isOwnServerRunning(options.port)) {
      // Another instance owns the port; do not start a duplicate.
      Script.exit({ ok: true, alreadyRunning: true, port: options.port })
      return
    }
    const error = await startServer(options)
    if (error) {
      Script.exit({ ok: false, error, port: options.port })
      return
    }
  }

  await presentStatusPage(options)
}

/**
 * Run the HTTP server without opening the main page. Never resolves after a
 * successful start; the instance stays alive until /v1/shutdown or a stop
 * request through Script.onResume.
 */
export async function runStandaloneMode(params: Params): Promise<void> {
  const settings = loadSettings()
  const options: ServerOptions = {
    port: portParam(params.port, settings.serverPort),
    keepAlive: boolParam(params.keepAlive, settings.serverKeepAlive),
    wakeLock: boolParam(params.wakeLock, settings.serverKeepScreenOn),
  }
  const action = stringParam(params.action)

  Script.onResume(details => {
    void handleResume(details, options).catch(error => {
      console.error("Failed to handle server resume", error)
      Script.exit({ ok: false, error: String(error), port: options.port })
    })
  })

  Script.onMinimize(() => {
    console.log("HTTP server minimized; still serving")
  })

  if (action === "stop") {
    await stopServer(options.port)
    Script.exit({ ok: true, stopped: true })
    return
  }

  if (!translationHttpServer.isRunning) {
    if (await isOwnServerRunning(options.port)) {
      Script.exit({ ok: true, alreadyRunning: true, port: options.port })
      return
    }
    const error = await startServer(options)
    if (error) {
      Script.exit({ ok: false, error, port: options.port })
      return
    }
  } else {
    translationHttpServer.setStandalone(true)
  }

  // Keep the script instance alive for HTTP requests.
  await new Promise<void>(() => {})
}
