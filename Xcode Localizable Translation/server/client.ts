/**
 * Client helpers for talking to a running HTTP server instance over localhost.
 * Used to detect an already-running server and to stop a headless instance.
 */

import { fetch } from "scripting"
import type { RequestInit } from "scripting"

const APP_ID = "xcstrings-translation"

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
) {
  return fetch(url, {
    ...init,
    timeout: Math.max(0.1, timeoutMs / 1000),
    allowInsecureRequest: true,
  })
}

/** True when our translation server answers on 127.0.0.1:port. */
export async function isOwnServerRunning(
  port: number,
  timeoutMs = 700,
): Promise<boolean> {
  if (!Number.isFinite(port) || port <= 0) {
    return false
  }
  try {
    const response = await fetchWithTimeout(
      `http://127.0.0.1:${port}/v1/health`,
      { method: "GET" },
      timeoutMs,
    )
    if (!response.ok) {
      return false
    }
    const payload = await response.json() as { app?: string } | null
    return payload?.app === APP_ID
  } catch {
    return false
  }
}

/** Ask a running instance to stop. Returns true when it accepted the request. */
export async function requestShutdown(
  port: number,
  timeoutMs = 1500,
): Promise<boolean> {
  if (!Number.isFinite(port) || port <= 0) {
    return false
  }
  try {
    const response = await fetchWithTimeout(
      `http://127.0.0.1:${port}/v1/shutdown`,
      { method: "POST" },
      timeoutMs,
    )
    return response.ok
  } catch {
    return false
  }
}
