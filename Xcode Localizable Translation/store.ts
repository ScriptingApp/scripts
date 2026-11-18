/**
 * Store: persisted user settings + AI provider/model discovery.
 *
 * Settings are persisted via the Scripting `Storage` API.
 * Provider/model options are discovered from the iCloud `.scripting` config:
 *   - <iCloud>/Documents/.scripting/agent-custom-providers.json  (custom providers)
 *   - <iCloud>/Documents/.scripting/agent-custom-models.json     (built-in extra models)
 */

const SETTINGS_KEY = "xcstrings.translation.settings.v2"
const PORT_DEFAULT_REVISION = 2

import { LANGUAGES } from "./languages"

export type BuiltInProviderId =
  | "openai"
  | "gemini"
  | "anthropic"
  | "deepseek"
  | "openrouter"

export const BUILT_IN_PROVIDERS: BuiltInProviderId[] = [
  "openai",
  "gemini",
  "anthropic",
  "deepseek",
  "openrouter",
]

/** A flattened provider option for the UI selector. */
export type ProviderOption = {
  /** Stable key: built-in id, or `custom:<name>` for custom providers. */
  key: string
  /** Display label. */
  label: string
  /** Whether this is a custom provider. */
  isCustom: boolean
  /** For custom providers, the `name` used as `{ custom: name }`. */
  customName?: string
  /** Available model ids for this provider. */
  models: string[]
  /** Provider's default model id, if any. */
  defaultModelId?: string
}

export type TranslationSettings = {
  /** Interval between request starts, in milliseconds. */
  intervalMs: number
  /** Concurrency (1..5). */
  concurrency: number
  /** Number of items per translation request. */
  batchSize: number
  /** Selected target locales. */
  locales: string[]
  /** Selected provider option key. */
  providerKey: string
  /** Selected model id. */
  modelId: string
  /** Keep the screen awake while translating. */
  keepScreenOn: boolean
  /** Keep the app alive in background while translating. */
  keepAlive: boolean
  /** HTTP server port. */
  serverPort: number
  /** Start the HTTP server automatically when the page opens. */
  autoStartServer: boolean
  /** Keep the app alive while the HTTP server is running. */
  serverKeepAlive: boolean
  /** Keep the screen awake while the HTTP server is running. */
  serverKeepScreenOn: boolean
}

export const DEFAULT_SETTINGS: TranslationSettings = {
  intervalMs: 1000,
  concurrency: 1,
  batchSize: 30,
  locales: LANGUAGES.map(l => l.locale),
  providerKey: "openrouter",
  modelId: "",
  keepScreenOn: true,
  keepAlive: true,
  serverPort: 7777,
  autoStartServer: false,
  serverKeepAlive: true,
  serverKeepScreenOn: false,
}

type StoredSettings = Partial<TranslationSettings> & {
  portDefaultRevision?: number
}

export function loadSettings(): TranslationSettings {
  try {
    const saved = Storage.get<StoredSettings>(SETTINGS_KEY)
    if (saved && typeof saved === "object") {
      const merged: TranslationSettings = { ...DEFAULT_SETTINGS, ...saved }
      // One-time migration: the old default port was 8787.
      if ((saved.portDefaultRevision ?? 1) < PORT_DEFAULT_REVISION) {
        if (saved.serverPort === undefined || saved.serverPort === 8787) {
          merged.serverPort = DEFAULT_SETTINGS.serverPort
        }
        Storage.set(SETTINGS_KEY, {
          ...merged,
          portDefaultRevision: PORT_DEFAULT_REVISION,
        })
      }
      return merged
    }
  } catch (e) {
    console.error("Failed to load settings:", e)
  }
  return { ...DEFAULT_SETTINGS }
}

export function saveSettings(settings: TranslationSettings) {
  try {
    Storage.set(SETTINGS_KEY, {
      ...settings,
      portDefaultRevision: PORT_DEFAULT_REVISION,
    })
  } catch (e) {
    console.error("Failed to save settings:", e)
  }
}

type CustomProviderEntry = {
  name?: string
  apiType?: string
  currentModelId?: string
  modelInfos?: Record<string, unknown>
}

type CustomModelsFile = {
  models?: Record<string, Record<string, unknown>>
}

function iCloudConfigPath(file: string): string | null {
  try {
    if (!FileManager.isiCloudEnabled) {
      return null
    }
    return `${FileManager.iCloudDocumentsDirectory}/.scripting/${file}`
  } catch (e) {
    console.error("iCloud not available:", e)
    return null
  }
}

async function readJson<T>(path: string | null): Promise<T | null> {
  if (!path) {
    return null
  }
  try {
    if (!(await FileManager.exists(path))) {
      return null
    }
    const content = await FileManager.readAsString(path)
    return JSON.parse(content) as T
  } catch (e) {
    console.error("Failed to read config:", path, e)
    return null
  }
}

/**
 * Discover available provider options:
 * - Built-in providers, with models discovered from agent-custom-models.json.
 * - Custom providers from agent-custom-providers.json.
 */
export async function discoverProviders(): Promise<ProviderOption[]> {
  const options: ProviderOption[] = []

  // Built-in providers + their configured models.
  const modelsFile = await readJson<CustomModelsFile>(
    iCloudConfigPath("agent-custom-models.json"),
  )
  const modelsMap = modelsFile?.models ?? {}

  for (const id of BUILT_IN_PROVIDERS) {
    const group = modelsMap[`${id}.custom.models`]
    const models = group ? Object.keys(group) : []
    options.push({
      key: id,
      label: id,
      isCustom: false,
      models,
      defaultModelId: models[0],
    })
  }

  // Custom providers.
  const custom = await readJson<CustomProviderEntry[]>(
    iCloudConfigPath("agent-custom-providers.json"),
  )
  if (Array.isArray(custom)) {
    for (const entry of custom) {
      const name = entry?.name
      if (!name) {
        continue
      }
      const models = entry.modelInfos ? Object.keys(entry.modelInfos) : []
      options.push({
        key: `custom:${name}`,
        label: name,
        isCustom: true,
        customName: name,
        models,
        defaultModelId: entry.currentModelId ?? models[0],
      })
    }
  }

  return options
}

/** Resolve a provider option + model id into an Assistant provider selection. */
export function toProviderSelection(
  option: ProviderOption,
  modelId: string,
): { provider: Assistant.Provider; modelId?: string } {
  const provider: Assistant.Provider = option.isCustom
    ? { custom: option.customName! }
    : (option.key as BuiltInProviderId)
  return {
    provider,
    modelId: modelId || option.defaultModelId || undefined,
  }
}
