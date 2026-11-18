import { Button, List, Navigation, Section, Script, Text } from "scripting"
import { TranslationSettings } from "../store"
import { ServerPanel } from "./ServerPanel"
import { minimizeCurrentScript } from "../util"
import { t } from "../i18n"

type Props = {
  settings: TranslationSettings
  updateSettings: (patch: Partial<TranslationSettings>) => void
  log: (message: string) => void
  /** Presented as a standalone modal; show a close button. */
  standalone?: boolean
  /** Called after the server is stopped from this page. */
  onStopped?: () => void
}

export function ServerPage({
  settings,
  updateSettings,
  log,
  standalone = false,
  onStopped,
}: Props) {
  const dismiss = Navigation.useDismiss()
  const canMinimize = Script.supportsMinimization()

  const handleMinimize = async () => {
    const result = await minimizeCurrentScript()
    if (result === "unsupported") {
      log(t.minimizeUnsupported)
    } else if (result === "failed") {
      log(t.minimizeFailed)
    }
  }

  return (
    <List
      navigationTitle={t.serverSection}
      navigationBarTitleDisplayMode="inline"
      toolbar={{
        cancellationAction: standalone
          ? <Button title={t.close} action={dismiss} />
          : undefined,
        topBarTrailing: (
          <Button
            title={t.minimize}
            action={() => { void handleMinimize() }}
            disabled={!canMinimize}
          />
        ),
      }}
    >
      <ServerPanel
        settings={settings}
        updateSettings={updateSettings}
        log={log}
        onStopped={onStopped}
      />
      <Section>
        <Text font="caption" foregroundStyle="secondaryLabel">
          {t.serverMinimizeHint}
        </Text>
      </Section>
    </List>
  )
}
