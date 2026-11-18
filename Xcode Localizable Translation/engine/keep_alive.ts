/**
 * Reference-counted background keep-alive + wake lock.
 *
 * Both the UI translation run and the HTTP server may need to keep the process
 * alive. BackgroundKeeper.stopKeepAlive() is script-scoped, so a naive
 * acquire/release pair would let one side release the other side's request.
 * Holders are tracked here and the native resources are released only when the
 * last holder leaves.
 */

export type KeepAliveOptions = {
  /** Request the background resource. Defaults to true. */
  keepAlive?: boolean
  /** Keep the screen awake while this holder is active. Defaults to false. */
  wakeLock?: boolean
}

type Holder = {
  keepAlive: boolean
  wakeLock: boolean
}

const holders = new Map<string, Holder>()
let keepAliveOn = false
let keepAlivePending = false
let wakeLockOn = false

function anyKeepAlive(): boolean {
  for (const holder of holders.values()) {
    if (holder.keepAlive) {
      return true
    }
  }
  return false
}

function anyWakeLock(): boolean {
  for (const holder of holders.values()) {
    if (holder.wakeLock) {
      return true
    }
  }
  return false
}

async function ensureKeepAlive(): Promise<void> {
  if (!anyKeepAlive() || keepAliveOn || keepAlivePending) {
    return
  }
  keepAlivePending = true
  try {
    const ok = await BackgroundKeeper.keepAlive()
    keepAliveOn = ok === true
    if (!keepAliveOn) {
      console.error("BackgroundKeeper.keepAlive() was not granted")
    }
  } catch (e) {
    keepAliveOn = false
    console.error("BackgroundKeeper.keepAlive() failed", e)
  } finally {
    keepAlivePending = false
  }
}

function syncWakeLock() {
  const wanted = anyWakeLock()
  if (wanted === wakeLockOn) {
    return
  }
  try {
    Device.setWakeLockEnabled(wanted)
    wakeLockOn = wanted
  } catch (e) {
    console.error("Device.setWakeLockEnabled failed", e)
  }
}

async function syncKeepAlive(): Promise<void> {
  if (anyKeepAlive()) {
    await ensureKeepAlive()
    return
  }
  if (!keepAliveOn) {
    return
  }
  try {
    await BackgroundKeeper.stopKeepAlive()
  } catch (e) {
    console.error("BackgroundKeeper.stopKeepAlive() failed", e)
  } finally {
    keepAliveOn = false
  }
}

/**
 * Acquire (or update) a named holder. Safe to call repeatedly with the same id.
 * Returns whether the keep-alive request is currently active.
 */
export async function acquire(
  holderId: string,
  options: KeepAliveOptions = {},
): Promise<boolean> {
  holders.set(holderId, {
    keepAlive: options.keepAlive !== false,
    wakeLock: options.wakeLock === true,
  })
  syncWakeLock()
  await ensureKeepAlive()
  return keepAliveOn
}

/** Release a holder. Native resources are stopped when the last holder leaves. */
export async function release(holderId: string): Promise<void> {
  holders.delete(holderId)
  syncWakeLock()
  await syncKeepAlive()
}

/** Update a holder without changing its identity. */
export async function update(
  holderId: string,
  options: KeepAliveOptions,
): Promise<boolean> {
  return acquire(holderId, options)
}

/** Release every holder (used by the script exit cleanup). */
export async function releaseAll(): Promise<void> {
  holders.clear()
  syncWakeLock()
  await syncKeepAlive()
}

export function isHeld(): boolean {
  return holders.size > 0
}

export function hasKeepAlive(): boolean {
  return keepAliveOn
}

export function hasWakeLock(): boolean {
  return wakeLockOn
}
