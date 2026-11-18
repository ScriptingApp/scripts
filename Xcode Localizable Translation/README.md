# Xcode Localizable Translation

A Scripting script for translating Xcode `Localizable.xcstrings` files, with an optional local HTTP API so other devices and tools can reuse the same AI provider.

## Usage (in-app)

- Open your iOS project in Xcode
- Open the Localizable file in the project as Source Code and copy all the contents
- Run the script in the Scripting app
- After the script recognizes the legal `Localizable.xcstrings` format, it asks whether to start translating
- After confirmation it starts translating and finally sets the result to the clipboard
- Paste it directly into the Localizable file

## HTTP Server

### 1. Start the server

1. Connect the iPhone and the client (Mac / another phone / Shortcuts) to the **same Wi-Fi / LAN**.
2. Open the script. Tap **HTTP** in the top-right corner of the main page.
3. On the server page:
   - **Port**: default `7777`. You can change it while the server is stopped (1024–65535).
   - **Enable HTTP Server**: turn it on.
   - **Background keep-alive**: recommended on, so the process survives backgrounding.
   - **Keep screen on**: optional, useful for long jobs.
4. After it starts, the page shows one or more addresses, for example:
   ```
   http://192.168.1.23:7777
   ```
   Tap **Copy** and use that base URL from the client.
5. Check it from a browser or terminal:

```bash
curl -s http://192.168.1.23:7777/v1/health
```

```json
{
  "ok": true,
  "app": "xcstrings-translation",
  "version": "1.0.0",
  "state": "running",
  "port": 7777,
  "busy": false,
  "queued": 0,
  "provider": "openrouter",
  "model": "deepseek/deepseek-v4-flash"
}
```

If several addresses are listed, prefer the Wi-Fi one (`en0`). VPN / virtual interface addresses only work when the client uses the same VPN route.

### 2. Minimize vs. close

- Tap **Minimize** in the top-right corner (available on both the main page and the server page), or swipe the root page to minimize.
- Minimizing hides the UI but **does not terminate the script**; the HTTP server keeps listening in the same process.
- Restore it from the running scripts list. The server state (port, jobs) is preserved.
- Tapping **Close** on the main page calls `Script.exit()` and **stops the server, cancels HTTP jobs and releases the port**.
- Minimization is ignored in multiple-windows mode. Background execution is still best effort: iOS may suspend or terminate the app under memory pressure or after long background time.

> **No authentication.** Any device on the same network can call the API, spend your AI quota, or stop the server via `/v1/shutdown`. Never expose this port to the internet or an untrusted network.

Provider and model always come from the page settings; they cannot be overridden per request.

### 3. Headless mode (Script.run)

The same script can run **without presenting any page**. `index.tsx` checks `Script.queryParameters` and enters server-only mode.

Start (do **not** await — a healthy server never exits, so the promise stays pending):

```ts
Script.run({
  name: "Xcode Localizable Translation",
  queryParameters: { mode: "server", port: 7777 }
})
```

- `mode: "server"` (or `server: 1`) selects headless mode; no UI is opened.
- `port` defaults to the saved setting (`7777`).
- `keepAlive` / `wakeLock` are optional booleans.
- The target probes `/v1/health` first. If a server is already running on that port, it exits with `{ ok: true, alreadyRunning: true, port }`; no duplicate instance is started.
- **Do not use `singleMode`**: it would terminate the running server instance.
- `Script.run` may ask for permission; allow the call for this script pair.

Stop a running headless server:

```ts
await Script.run({
  name: "Xcode Localizable Translation",
  queryParameters: { mode: "server", port: 7777, action: "stop" }
})
```

This sends `POST /v1/shutdown` to the running instance and exits with `{ ok: true, stopped: true }`.

Resume behavior:

- Tapping the headless script in the running scripts list triggers `Script.onResume`, which presents the server page.
- Closing that page keeps the server running; toggling the server off exits the headless instance.
- A resume with `action=stop` stops it.
- If the app suspended the server, resume tries to restart it on the same port.

URL scheme alternative (also without `run_single`):

```
scripting://run/Xcode%20Localizable%20Translation?mode=server&port=7777
```

### 4. Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/v1/health` | Server state, port, provider, queue |
| GET | `/v1/languages` | Supported locales + aliases |
| POST | `/v1/translate` | Translate plain texts |
| POST | `/v1/xcstrings?locales=zh-Hans,ja` | Translate a full xcstrings document (sync) |
| POST | `/v1/xcstrings?locales=...&async=1` | Start an async job, returns `jobId` |
| GET | `/v1/jobs` | Recent jobs |
| GET | `/v1/jobs/:id` | Job status + per-locale progress |
| GET | `/v1/jobs/:id/result` | Translated xcstrings JSON |
| DELETE | `/v1/jobs/:id` | Cancel a queued/running job |
| POST | `/v1/shutdown` | Stop the server (headless instance exits) |

### 5. Translate plain texts

```bash
curl -s http://192.168.1.23:7777/v1/translate \
  -H 'Content-Type: application/json' \
  -d '{
    "texts": ["Hello", "Cancel"],
    "targets": ["zh-Hans", "ja"],
    "source": "en",
    "profile": "plain"
  }'
```

```json
{
  "ok": true,
  "partial": false,
  "results": {
    "zh-Hans": ["你好", "取消"],
    "ja": ["こんにちは", "キャンセル"]
  },
  "failed": {},
  "stats": { "texts": 2, "unique": 2, "targets": 2, "batches": 2, "elapsedMs": 1200 }
}
```

`results[locale]` is aligned with the input indexes. Duplicate texts are translated once. Failed slots are `null` and listed in `failed[locale]`.

### 6. Translate a whole xcstrings file

```bash
curl -s 'http://192.168.1.23:7777/v1/xcstrings?locales=zh-Hans,ja' \
  -H 'Content-Type: application/json' \
  --data-binary @Localizable.xcstrings \
  -o Localizable.translated.xcstrings
```

Response headers:

- `X-Translation-Status: completed | partial`
- `X-Translation-Summary: {"zh-Hans":{"total":120,"done":120,"failed":0}}`

Existing localizations are preserved; `shouldTranslate: false` entries are skipped. If `locales` is omitted, the page's selected languages are used; `X-Target-Locales: zh-Hans,ja` is also accepted.

### 7. Async jobs (recommended for large files)

```bash
# 1. Start
curl -s 'http://192.168.1.23:7777/v1/xcstrings?locales=zh-Hans,ja&async=1' \
  -H 'Content-Type: application/json' \
  --data-binary @Localizable.xcstrings
# => {"ok":true,"jobId":"job_..."}

# 2. Poll progress
curl -s http://192.168.1.23:7777/v1/jobs/job_...

# 3. Download the result
curl -s http://192.168.1.23:7777/v1/jobs/job_.../result \
  -o Localizable.translated.xcstrings
```

Job statuses: `queued | running | completed | partial | failed | cancelled`.

### 8. Shortcuts

Use **Get Contents of URL**:

- URL: `http://<iPhone-IP>:7777/v1/translate`
- Method: `POST`
- Headers: `Content-Type: application/json`
- Request Body: JSON with `texts` and `targets`

For a full file, use `/v1/xcstrings?locales=...` with the file as the request body. For long files, use `?async=1` and poll `/v1/jobs/:id` to avoid URLSession's timeout.

### 9. Troubleshooting

- **Cannot connect**: confirm both devices are on the same network, the server toggle says **Running**, and you copied the Wi-Fi address (not a VPN address). Some guest Wi-Fi networks enable AP isolation, which blocks device-to-device traffic.
- **Connection works, then stops**: iOS may suspend the app. Keep **Background keep-alive** on, minimize instead of closing, and avoid long periods in the background. Starting the server again restarts it on the same port.
- **502 / provider_not_configured**: select a provider on the main page and make sure its API key is configured.
- **429 / queue_full**: another job is running or 8 jobs are waiting; retry after a few seconds.
- **400 / invalid_json**: send `Content-Type: application/json` and a valid JSON body.
- **Port in use**: stop the server and choose another port (default `7777`).

### 10. Limits

- Request body: 20 MB
- `/v1/translate`: up to 500 texts / 100k characters
- One translation job runs at a time; queue limit is 8 (HTTP `429` when full)
- Async job results live in memory: latest 20 jobs, 30-minute TTL

## Requirements

- Scripting PRO feature
- Select an API provider; ChatGPT 4o or Google Gemini 2.0 is recommended
- Ensure you have set an available API key for the specified API provider
