import {
  Navigation,
  NavigationStack,
  NavigationLink,
  Toolbar,
  ToolbarItem,
  ToolbarSpacer,
  List,
  Section,
  VStack,
  HStack,
  Text,
  Button,
  Toggle,
  Slider,
  Stepper,
  Picker,
  ProgressView,
  ScrollView,
  Spacer,
  useState,
  useMemo,
  useEffect,
Script,
} from "scripting"
import { LocalizableData } from "../xcstrings_util"
import { LANGUAGES } from "../languages"
import {
  TranslationSettings,
  ProviderOption,
  loadSettings,
  saveSettings,
  discoverProviders,
  toProviderSelection,
} from "../store"
import { SchedulerController } from "../engine/scheduler"
import { runTranslation, LocaleProgress } from "../engine/runner"
import { translationQueue, QueueFullError, JobCancelledError } from "../engine/job_queue"
import * as keepAlive from "../engine/keep_alive"
import {
  parseClipboardSource,
  serializeResult,
  exportResult,
  minimizeCurrentScript,
} from "../util"
import { t } from "../i18n"
import { ServerPage } from "./ServerPage"

type Phase = "idle" | "ready" | "running" | "paused" | "completed" | "cancelled" | "error"

function statusLabel(phase: Phase): { text: string; color: string } {
  switch (phase) {
    case "idle": return { text: t.phaseIdle, color: "secondaryLabel" }
    case "ready": return { text: t.phaseReady, color: "blue" }
    case "running": return { text: t.phaseRunning, color: "green" }
    case "paused": return { text: t.phasePaused, color: "orange" }
    case "completed": return { text: t.phaseCompleted, color: "green" }
    case "cancelled": return { text: t.phaseCancelled, color: "red" }
    case "error": return { text: t.phaseError, color: "red" }
  }
}

function localeStatusText(p: LocaleProgress): string {
  switch (p.status) {
    case "pending": return t.localePending
    case "running": return t.localeRunning
    case "completed": return t.localeCompleted
    case "partial": return t.localePartial(p.failed)
  }
}

function localeStatusColor(p: LocaleProgress): string {
  switch (p.status) {
    case "pending": return "secondaryLabel"
    case "running": return "blue"
    case "completed": return "green"
    case "partial": return "orange"
  }
}

export function TranslationApp() {
  const dismiss = Navigation.useDismiss()

  const [settings, setSettings] = useState<TranslationSettings>(() => loadSettings())
  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [phase, setPhase] = useState<Phase>("idle")
  const [data, setData] = useState<LocalizableData | null>(null)
  const [progress, setProgress] = useState<Record<string, LocaleProgress>>({})
  const [logs, setLogs] = useState<string[]>([])

  // Controller is stable across renders via lazy state init.
  const [controller] = useState(() => new SchedulerController())

  // Load providers once.
  useEffect(() => {
    discoverProviders().then(opts => {
      setProviders(opts)
      // If saved provider key is no longer available, fall back to first option.
      setSettings(prev => {
        const exists = opts.some(o => o.key === prev.providerKey)
        if (exists) return prev
        const first = opts[0]
        return first ? { ...prev, providerKey: first.key, modelId: first.defaultModelId ?? "" } : prev
      })
    })
  }, [])

  const selectedProvider = useMemo(
    () => providers.find(o => o.key === settings.providerKey),
    [providers, settings.providerKey],
  )

  const customProviders = useMemo(() => providers.filter(o => o.isCustom), [providers])
  const builtInProviders = useMemo(() => providers.filter(o => !o.isCustom), [providers])

  const log = (message: string) => {
    setLogs(prev => [...prev.slice(-200), message])
  }

  const updateSettings = (patch: Partial<TranslationSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch }
      saveSettings(next)
      return next
    })
  }

  const minimize = async () => {
    const result = await minimizeCurrentScript()
    if (result === "unsupported") {
      log(t.minimizeUnsupported)
    } else if (result === "failed") {
      log(t.minimizeFailed)
    }
  }

  // ---- Actions ----

  const handlePaste = async () => {
    const parsed = await parseClipboardSource()
    if (!parsed) {
      log(t.logParseFailed)
      setPhase("error")
      return
    }
    setData(parsed)
    setProgress({})
    setLogs([])
    setPhase("ready")
    log(t.logRecognized(Object.keys(parsed.strings).length))
  }

  const toggleLocale = (locale: string) => {
    setSettings(prev => {
      const has = prev.locales.includes(locale)
      const locales = has
        ? prev.locales.filter(l => l !== locale)
        : [...prev.locales, locale]
      const next = { ...prev, locales }
      saveSettings(next)
      return next
    })
  }

  const startTranslation = async () => {
    if (!data) return
    if (!selectedProvider) {
      log(t.logNoProvider)
      return
    }
    const targetLocales = settings.locales.length > 0
      ? settings.locales
      : LANGUAGES.map(l => l.locale)
    const languages = LANGUAGES.filter(l => targetLocales.includes(l.locale))

    // Reset controller so a previous cancel/pause does not block this run.
    controller.reset()
    setPhase("running")

    const selection = toProviderSelection(selectedProvider, settings.modelId)
    if (translationQueue.isBusy) {
      log(t.logQueued)
    }

    try {
      await translationQueue.enqueue(
        async ctrl => {
          await keepAlive.acquire("ui", {
            keepAlive: settings.keepAlive,
            wakeLock: settings.keepScreenOn,
          })
          try {
            await runTranslation({
              data,
              languages,
              selection,
              concurrency: settings.concurrency,
              intervalMs: settings.intervalMs,
              batchSize: settings.batchSize,
              controller: ctrl,
              callbacks: {
                onLog: log,
                onProgress: p => setProgress({ ...p }),
              },
            })
          } finally {
            await keepAlive.release("ui")
          }
        },
        { id: "ui", label: "ui", controller },
      )

      if (controller.isCancelled) {
        setPhase("cancelled")
        log(t.logCancelled)
      } else {
        setPhase("completed")
        log(t.logCompleted)
      }
    } catch (e) {
      if (e instanceof QueueFullError) {
        setPhase("error")
        log(t.logQueueFull)
      } else if (e instanceof JobCancelledError) {
        setPhase("cancelled")
        log(t.logCancelled)
      } else {
        setPhase("error")
        log(t.logError(e))
      }
    }
  }

  const pause = () => {
    controller.pause()
    setPhase("paused")
    log(t.logPaused)
  }

  const resume = () => {
    controller.resume()
    setPhase("running")
    log(t.logResumed)
  }

  const cancel = () => {
    controller.cancel()
    translationQueue.cancel("ui")
    log(t.logCancelling)
  }

  const copyResult = async () => {
    if (!data) return
    await Clipboard.copyText(serializeResult(data))
    log(t.logCopied)
  }

  const doExport = async () => {
    if (!data) return
    const ok = await exportResult(data)
    log(ok ? t.logExported : t.logExportFailed)
  }

  // ---- Derived ----

  const totalAll = Object.values(progress).reduce((s, p) => s + p.total, 0)
  const doneAll = Object.values(progress).reduce((s, p) => s + p.done + p.failed, 0)
  const failedAll = Object.values(progress).reduce((s, p) => s + p.failed, 0)
  const overall = totalAll > 0 ? doneAll / totalAll : 0

  const status = statusLabel(phase)
  const canEditSettings = phase === "idle" || phase === "ready" || phase === "completed" || phase === "cancelled" || phase === "error"
  const isWorking = phase === "running" || phase === "paused"

  return (
    <NavigationStack>
      <List
        navigationTitle={t.navTitle}
        navigationBarTitleDisplayMode="inline"
        toolbar={
          <Toolbar>
            <ToolbarItem placement="cancellationAction">
              <Button title={t.close} action={dismiss} />
            </ToolbarItem>
            <ToolbarItem placement="topBarTrailing">
              <Button
                title={t.minimize}
                action={() => { void minimize() }}
                disabled={!Script.supportsMinimization()}
              />
            </ToolbarItem>
            <ToolbarSpacer sizing="fixed" placement="topBarTrailing" />
            <ToolbarItem placement="topBarTrailing">
              <NavigationLink
                title={t.serverButton}
                destination={
                  <ServerPage
                    settings={settings}
                    updateSettings={updateSettings}
                    log={log}
                  />
                }
              />
            </ToolbarItem>
          </Toolbar>
        }
      >
        {/* Status & overall progress */}
        <Section header={<Text>{t.statusSection}</Text>}>
          <HStack>
            <Text>{t.currentStatus}</Text>
            <Spacer />
            <Text foregroundStyle={status.color as any} font="headline">{status.text}</Text>
          </HStack>
          {totalAll > 0 ?
            <VStack alignment="leading" spacing={4}>
              <ProgressView value={overall} total={1} />
              <HStack>
                <Text font="caption" foregroundStyle="secondaryLabel">
                  {t.progressCount(doneAll, totalAll, Math.floor(overall * 100))}
                </Text>
                <Spacer />
                {failedAll > 0 ?
                  <Text font="caption" foregroundStyle="red">{t.failedCount(failedAll)}</Text>
                  : null}
              </HStack>
            </VStack>
            : phase === "idle" ?
              <Text font="caption" foregroundStyle="secondaryLabel">{t.idleHint}</Text>
              : null}
        </Section>

        {/* Input */}
        <Section header={<Text>{t.inputSection}</Text>}>
          <Button
            title={data ? t.repasteFromClipboard : t.pasteFromClipboard}
            action={handlePaste}
            disabled={isWorking}
          />
          {data ?
            <Text font="caption" foregroundStyle="secondaryLabel">
              {t.loadedEntries(Object.keys(data.strings).length)}
            </Text>
            : null}
        </Section>

        {/* Settings: AI model */}
        {canEditSettings ?
          <Section header={<Text>{t.modelSection}</Text>}>
            {providers.length > 0 ?
              <Picker
                title={t.provider}
                value={settings.providerKey}
                onChanged={(key: string) => {
                  const opt = providers.find(o => o.key === key)
                  updateSettings({
                    providerKey: key,
                    modelId: opt?.defaultModelId ?? "",
                  })
                }}
              >
                {customProviders.length > 0 ?
                  <Section header={<Text>{t.customGroup}</Text>}>
                    {customProviders.map(o =>
                      <Text tag={o.key}>{o.label}</Text>
                    )}
                  </Section>
                  : null}
                <Section header={<Text>{t.builtInGroup}</Text>}>
                  {builtInProviders.map(o =>
                    <Text tag={o.key}>{o.label}</Text>
                  )}
                </Section>
              </Picker>
              : <Text foregroundStyle="secondaryLabel">{t.loadingProviders}</Text>}

            {selectedProvider && selectedProvider.models.length > 0 ?
              <Picker
                title={t.model}
                value={settings.modelId || selectedProvider.defaultModelId || ""}
                onChanged={(modelId: string) => updateSettings({ modelId })}
              >
                {selectedProvider.models.map(m =>
                  <Text tag={m}>{m}</Text>
                )}
              </Picker>
              : null}
          </Section>
          : null}

        {/* Settings: performance */}
        {canEditSettings ?
          <Section
            header={<Text>{t.performanceSection}</Text>}
            footer={<Text>{t.performanceFooter}</Text>}
          >
            <VStack alignment="leading">
              <Text>{t.requestInterval(settings.intervalMs)}</Text>
              <Slider
                value={settings.intervalMs}
                min={0}
                max={5000}
                step={100}
                onChanged={(v: number) => updateSettings({ intervalMs: Math.round(v) })}
              />
            </VStack>

            <Stepper
              title={t.concurrency(settings.concurrency)}
              onIncrement={() => updateSettings({ concurrency: Math.min(5, settings.concurrency + 1) })}
              onDecrement={() => updateSettings({ concurrency: Math.max(1, settings.concurrency - 1) })}
            />

            <Stepper
              title={t.batchSize(settings.batchSize)}
              onIncrement={() => updateSettings({ batchSize: Math.min(100, settings.batchSize + 5) })}
              onDecrement={() => updateSettings({ batchSize: Math.max(5, settings.batchSize - 5) })}
            />
          </Section>
          : null}

        {/* Settings: runtime options */}
        {canEditSettings ?
          <Section
            header={<Text>{t.runtimeSection}</Text>}
            footer={<Text>{t.runtimeFooter}</Text>}
          >
            <Toggle
              title={t.keepScreenOn}
              value={settings.keepScreenOn}
              onChanged={(v: boolean) => updateSettings({ keepScreenOn: v })}
            />
            <Toggle
              title={t.keepAlive}
              value={settings.keepAlive}
              onChanged={(v: boolean) => updateSettings({ keepAlive: v })}
            />
          </Section>
          : null}

        {/* Language selection */}
        {canEditSettings ?
          <Section
            header={
              <HStack>
                <Text>{t.targetLanguages}</Text>
                <Spacer />
                <Text font="caption" foregroundStyle="secondaryLabel">
                  {settings.locales.length === LANGUAGES.length
                    ? t.selectedAll
                    : t.selectedCount(settings.locales.length)}
                </Text>
              </HStack>
            }
            footer={<Text>{t.targetLangFooter}</Text>}
          >
            {LANGUAGES.map(lang =>
              <Toggle
                title={`${lang.name} (${lang.locale})`}
                value={settings.locales.includes(lang.locale)}
                onChanged={() => toggleLocale(lang.locale)}
              />
            )}
          </Section>
          : null}

        {/* Per-language progress */}
        {Object.keys(progress).length > 0 ?
          <Section header={<Text>{t.languageProgress}</Text>}>
            {Object.values(progress).map(p =>
              <HStack>
                <Text>{p.name}</Text>
                <Spacer />
                <Text font="caption" foregroundStyle="secondaryLabel">
                  {p.done}/{p.total} · {localeStatusText(p)}
                </Text>
              </HStack>
            )}
          </Section>
          : null}

        {/* Actions */}
        <Section header={<Text>{t.actionsSection}</Text>}>
          {phase === "ready" || phase === "completed" || phase === "cancelled" || phase === "error" ?
            <Button
              title={t.start}
              action={startTranslation}
              disabled={!data || settings.locales.length === 0}
            />
            : null}
          {phase === "running" ?
            <Button title={t.pause} action={pause} />
            : null}
          {phase === "paused" ?
            <Button title={t.resume} action={resume} />
            : null}
          {isWorking ?
            <Button title={t.cancel} role="destructive" action={cancel} />
            : null}
          {(phase === "completed" || phase === "cancelled" || phase === "paused") && data ?
            <>
              <Button title={t.copyResult} action={copyResult} />
              <Button title={t.exportFile} action={doExport} />
            </>
            : null}
        </Section>

        {/* Logs */}
        {logs.length > 0 ?
          <Section header={<Text>{t.logsSection}</Text>}>
            <ScrollView frame={{ height: 160 }}>
              <VStack alignment="leading" spacing={2}>
                {logs.map((line, i) =>
                  <Text key={String(i)} font="caption" foregroundStyle="secondaryLabel">
                    {line}
                  </Text>
                )}
              </VStack>
            </ScrollView>
          </Section>
          : null}
      </List>
    </NavigationStack>
  )
}
