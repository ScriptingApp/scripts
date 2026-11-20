import { Navigation, Script } from "scripting"
import { TranslationApp } from "./components/TranslationApp"
import { translationHttpServer } from "./server/http_server"
import { isServerMode, runStandaloneMode } from "./server/standalone"
import { isBatchMode, runBatchMode } from "./engine/batch_cli"
import * as keepAlive from "./engine/keep_alive"

async function run() {
  const params = (Script.queryParameters ?? {}) as Record<string, any>
  if (isServerMode(params)) {
    await runStandaloneMode(params)
    return
  }

  if (isBatchMode(params)) {
    // Headless project-level pipeline; exits with a JSON report.
    await runBatchMode(params)
    return
  }

  const canMinimize = Script.supportsMinimization()
  try {
    if (canMinimize) {
      // Swiping the root page away minimizes the script instead of ending it,
      // so a running HTTP server keeps serving in the background.
      Script.enableMinimize()
    }
    await Navigation.present({
      element: <TranslationApp />,
      modalPresentationStyle: "overFullScreen",
      swipeBackBehavior: canMinimize ? "minimize" : "disabled",
    })
  } finally {
    // Safety cleanup: stop the HTTP server first (cancels queued jobs), then
    // release keep-alive/wake-lock holders even if the page was dismissed.
    try {
      await translationHttpServer.stop()
    } catch (e) {
      console.error(e)
    }
    try {
      await keepAlive.releaseAll()
    } catch (e) {
      console.error(e)
    }
    Script.exit()
  }
}

run()
