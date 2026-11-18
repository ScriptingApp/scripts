import {
  Button,
  HStack,
  Section,
  Spacer,
  Text,
  TextField,
  Toggle,
  VStack,
  useEffect,
  useState,
} from "scripting"
import { TranslationSettings } from "../store"
import { translationHttpServer, ServerSnapshot, ServerState } from "../server/http_server"
import { isOwnServerRunning } from "../server/client"
import { t } from "../i18n"

type Props = {
  settings: TranslationSettings
  updateSettings: (patch: Partial<TranslationSettings>) => void
  log: (message: string) => void
  onStopped?: () => void
}

function stateLabel(state: ServerState): { text: string; color: string } {
  switch (state) {
    case "starting":
      return { text: t.serverStateStarting, color: "orange" }
    case "running":
      return { text: t.serverStateRunning, color: "green" }
    case "stopping":
      return { text: t.serverStateStopping, color: "orange" }
    case "error":
      return { text: t.serverStateError, color: "red" }
    default:
      return { text: t.serverStateStopped, color: "secondaryLabel" }
  }
}

export function ServerPanel({ settings, updateSettings, log, onStopped }: Props) {
  const [snapshot, setSnapshot] = useState<ServerSnapshot>(() => translationHttpServer.snapshot)
  const [portText, setPortText] = useState(String(settings.serverPort))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setSnapshot(translationHttpServer.snapshot)
    return translationHttpServer.subscribe(() => {
      setSnapshot(translationHttpServer.snapshot)
    })
  }, [])

  useEffect(() => {
    setPortText(String(settings.serverPort))
  }, [settings.serverPort])

  const startServer = async () => {
    if (busy || snapshot.state === "starting" || snapshot.state === "running") {
      return
    }
    setBusy(true)
    try {
      if (await isOwnServerRunning(settings.serverPort)) {
        log(t.serverAlreadyRunning)
        return
      }
      const error = await translationHttpServer.start(settings.serverPort, {
        keepAlive: settings.serverKeepAlive,
        wakeLock: settings.serverKeepScreenOn,
      })
      if (error) {
        log(t.serverStartFailed(error))
        return
      }
      const next = translationHttpServer.snapshot
      const url = next.urls[0] ?? `http://localhost:${next.port ?? settings.serverPort}`
      log(t.logServerStarted(url))
    } catch (e) {
      log(t.serverStartFailed(e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const stopServer = async () => {
    if (busy) {
      return
    }
    setBusy(true)
    try {
      await translationHttpServer.stop()
      log(t.logServerStopped)
      onStopped?.()
    } finally {
      setBusy(false)
    }
  }

  // Auto-start once on mount when enabled.
  useEffect(() => {
    if (settings.autoStartServer && !translationHttpServer.isRunning) {
      void startServer()
    }
  }, [])

  const commitPort = () => {
    const value = Number(portText)
    if (!Number.isFinite(value) || value < 1024 || value > 65535) {
      setPortText(String(settings.serverPort))
      return
    }
    if (Math.floor(value) !== settings.serverPort) {
      updateSettings({ serverPort: Math.floor(value) })
    }
  }

  const live = snapshot.state === "running" || snapshot.state === "starting"
  const status = stateLabel(snapshot.state)

  return (
    <Section
      header={<Text>{t.serverSettings}</Text>}
      footer={<Text>{t.serverFooter}</Text>}
    >
      <Toggle
        title={t.serverEnable}
        value={live}
        disabled={busy}
        onChanged={(value: boolean) => {
          if (value) {
            void startServer()
          } else {
            void stopServer()
          }
        }}
      />

      <HStack>
        <Text>{t.currentStatus}</Text>
        <Spacer />
        <Text font="caption" foregroundStyle={status.color as any}>
          {status.text}
        </Text>
      </HStack>

      {snapshot.state === "error" && snapshot.lastError ?
        <Text font="caption" foregroundStyle="red">{snapshot.lastError}</Text>
        : null}

      {live && snapshot.urls.length > 0 ?
        <VStack alignment="leading" spacing={4}>
          <Text font="caption" foregroundStyle="secondaryLabel">{t.serverAddress}</Text>
          {snapshot.urls.map(url =>
            <HStack key={url}>
              <Text font="caption" monospaced>{url}</Text>
              <Spacer />
              <Button
                title={t.serverCopy}
                buttonStyle="borderless"
                action={() => Clipboard.copyText(url)}
              />
            </HStack>
          )}
        </VStack>
        : live ?
          <Text font="caption" foregroundStyle="secondaryLabel">{t.serverNoAddress}</Text>
          : null}

      <HStack>
        <Text>{t.serverPort}</Text>
        <Spacer />
        <TextField
          title=""
          value={portText}
          onChanged={setPortText}
          onBlur={commitPort}
          onSubmit={commitPort}
          keyboardType="numberPad"
          multilineTextAlignment="trailing"
          frame={{ width: 120 }}
          disabled={live || busy}
        />
      </HStack>

      <Toggle
        title={t.serverAutoStart}
        value={settings.autoStartServer}
        onChanged={(value: boolean) => updateSettings({ autoStartServer: value })}
      />

      <Toggle
        title={t.serverKeepAlive}
        value={settings.serverKeepAlive}
        onChanged={(value: boolean) => {
          updateSettings({ serverKeepAlive: value })
          if (translationHttpServer.isRunning) {
            void translationHttpServer.updateKeepAlive({
              keepAlive: value,
              wakeLock: settings.serverKeepScreenOn,
            })
          }
        }}
      />

      <Toggle
        title={t.serverKeepScreenOn}
        value={settings.serverKeepScreenOn}
        onChanged={(value: boolean) => {
          updateSettings({ serverKeepScreenOn: value })
          if (translationHttpServer.isRunning) {
            void translationHttpServer.updateKeepAlive({
              keepAlive: settings.serverKeepAlive,
              wakeLock: value,
            })
          }
        }}
      />

      <VStack alignment="leading" spacing={4}>
        <Text font="caption" foregroundStyle="secondaryLabel">{t.serverRecentRequests}</Text>
        {snapshot.requests.length === 0 ?
          <Text font="caption" foregroundStyle="secondaryLabel">{t.serverNoRequests}</Text>
          : snapshot.requests.slice(0, 10).map((entry, index) =>
            <HStack key={`${entry.at}-${index}`}>
              <Text font="caption" monospaced lineLimit={1}>
                {`${entry.method} ${entry.path}`}
              </Text>
              <Spacer />
              <Text
                font="caption"
                foregroundStyle={entry.status >= 400 ? "red" : "secondaryLabel"}
              >
                {`${entry.status} · ${entry.durationMs}ms`}
              </Text>
            </HStack>
          )}
      </VStack>
    </Section>
  )
}
