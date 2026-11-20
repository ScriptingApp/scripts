/**
 * Self check for the style-preserving patcher.
 *
 * Run with:  scripting-ts run "<project>/tools/selfcheck.ts"
 * Exits { ok: true } when every case passes.
 */

import { Script } from "scripting"
import { patchXcstrings, verifyPatch, detectStyle } from "../xcstrings_patch"

type Case = { name: string; ok: boolean; detail?: string }

const XCODE_STYLE = `{
  "sourceLanguage" : "en",
  "strings" : {
    "Alpha" : {
      "shouldTranslate" : false
    },
    "Camera" : {
      "extractionState" : "manual",
      "localizations" : {
        "de" : {
          "stringUnit" : {
            "state" : "translated",
            "value" : "Kamera"
          }
        }
      }
    },
    "Save" : {
      "localizations" : {
        "de" : {
          "stringUnit" : {
            "state" : "translated",
            "value" : "Sichern"
          }
        }
      }
    },
    "Zebra" : {
      "extractionState" : "stale",
      "localizations" : {
        "de" : {
          "stringUnit" : {
            "state" : "translated",
            "value" : "Zebra"
          }
        }
      }
    }
  },
  "version" : "1.0"
}
`

const COMPACT_STYLE = `{
  "sourceLanguage": "en",
  "strings": {
    "Hello \\"%s\\"": {
      "localizations": {
        "de": {
          "stringUnit": {
            "state": "translated",
            "value": "Hallo \\"%s\\""
          }
        }
      }
    },
    "Line\\nbreak": {
      "extractionState": "stale",
      "localizations": {
        "de": {
          "stringUnit": {
            "state": "translated",
            "value": "Zeile"
          }
        }
      }
    },
    "Open": {
      "localizations": {
        "de": {
          "stringUnit": {
            "state": "translated",
            "value": "Öffnen"
          }
        }
      }
    }
  },
  "version": "1.0"
}
`

function caseStyleDetection(): Case {
  const a = detectStyle(XCODE_STYLE).colon
  const b = detectStyle(COMPACT_STYLE).colon
  if (a !== " : " || b !== ": ") {
    return {
      name: "style detection",
      ok: false,
      detail: `${JSON.stringify(a)} / ${JSON.stringify(b)}`,
    }
  }
  return { name: "style detection", ok: true }
}

function caseXcodeStyle(): Case {
  const plan = {
    insertions: {
      Alpha: [{ locale: "zh-Hans", value: "阿尔法" }],
      Camera: [
        { locale: "fr", value: "Appareil" },
        { locale: "ja", value: "カメラ" },
      ],
      Save: [{ locale: "en-GB", value: "Save" }],
    },
    replacements: { Camera: [{ locale: "de", value: "Kamera!" }] },
    removals: ["Zebra"],
  }
  const patched = patchXcstrings(XCODE_STYLE, plan)
  const expected = JSON.parse(XCODE_STYLE) as any
  delete expected.strings.Zebra
  expected.strings.Alpha.localizations = {
    "zh-Hans": { stringUnit: { state: "translated", value: "阿尔法" } },
  }
  expected.strings.Camera.localizations.de.stringUnit.value = "Kamera!"
  expected.strings.Camera.localizations.fr = {
    stringUnit: { state: "translated", value: "Appareil" },
  }
  expected.strings.Camera.localizations.ja = {
    stringUnit: { state: "translated", value: "カメラ" },
  }
  expected.strings.Save.localizations["en-GB"] = {
    stringUnit: { state: "translated", value: "Save" },
  }

  const verified = verifyPatch(expected, patched)
  if (!verified.ok) {
    return { name: "xcode style", ok: false, detail: verified.error }
  }
  if (!patched.includes(`"fr" : {`)) {
    return { name: "xcode style: colon", ok: false, detail: "colon style not preserved" }
  }
  if (!patched.includes(`\n        "fr" : {\n          "stringUnit" : {\n            "state" : "translated",\n            "value" : "Appareil"\n          }\n        },`)) {
    return { name: "xcode style: indent", ok: false, detail: `insert block formatting looks wrong:\n${patched.slice(patched.indexOf(`"fr"`) - 8, patched.indexOf(`"fr"`) + 160)}` }
  }
  const again = patchXcstrings(patched, plan)
  if (again !== patched) {
    return { name: "xcode style: idempotent", ok: false, detail: "second patch changed the file" }
  }
  return { name: "xcode style", ok: true }
}

function caseCompactStyle(): Case {
  const plan = {
    insertions: {
      Open: [
        { locale: "zh-Hans", value: "打开" },
        { locale: "ja", value: "開く" },
      ],
    },
    replacements: {},
    removals: ["Line\nbreak"],
  }
  const patched = patchXcstrings(COMPACT_STYLE, plan)
  const expected = JSON.parse(COMPACT_STYLE) as any
  delete expected.strings["Line\nbreak"]
  expected.strings.Open.localizations["zh-Hans"] = {
    stringUnit: { state: "translated", value: "打开" },
  }
  expected.strings.Open.localizations.ja = {
    stringUnit: { state: "translated", value: "開く" },
  }
  const verified = verifyPatch(expected, patched)
  if (!verified.ok) {
    return { name: "compact style", ok: false, detail: verified.error }
  }
  if (!patched.includes(`"zh-Hans": {`)) {
    return { name: "compact style: colon", ok: false, detail: "compact colon style lost" }
  }
  const again = patchXcstrings(patched, plan)
  if (again !== patched) {
    return { name: "compact style: idempotent", ok: false, detail: "second patch changed the file" }
  }
  return { name: "compact style", ok: true }
}

function caseRemoveFirstAndMiddle(): Case {
  const plan = { insertions: {}, replacements: {}, removals: ["Alpha", "Save"] }
  const patched = patchXcstrings(XCODE_STYLE, plan)
  const expected = JSON.parse(XCODE_STYLE) as any
  delete expected.strings.Alpha
  delete expected.strings.Save
  const verified = verifyPatch(expected, patched)
  if (!verified.ok) {
    return { name: "remove first+middle", ok: false, detail: verified.error }
  }
  return { name: "remove first+middle", ok: true }
}

function caseEmptyBody(): Case {
  const raw = `{
  "sourceLanguage" : "en",
  "strings" : {
    "Spacer" : {
    },
    "Title" : {
      "generatesSymbol" : false
    }
  },
  "version" : "1.0"
}
`
  const plan = {
    insertions: {
      Spacer: [{ locale: "zh-Hans", value: "间隔" }],
      Title: [{ locale: "zh-Hans", value: "标题" }],
    },
    replacements: {},
    removals: [],
  }
  const patched = patchXcstrings(raw, plan)
  const expected = JSON.parse(raw) as any
  expected.strings.Spacer.localizations = {
    "zh-Hans": { stringUnit: { state: "translated", value: "间隔" } },
  }
  expected.strings.Title.localizations = {
    "zh-Hans": { stringUnit: { state: "translated", value: "标题" } },
  }
  const verified = verifyPatch(expected, patched)
  if (!verified.ok) {
    return { name: "empty body", ok: false, detail: verified.error }
  }
  if (/^ +$/m.test(patched)) {
    return {
      name: "empty body: no stray indent line",
      ok: false,
      detail: "found a whitespace-only line",
    }
  }
  return { name: "empty body", ok: true }
}

function main() {
  const cases = [
    caseStyleDetection(),
    caseXcodeStyle(),
    caseCompactStyle(),
    caseRemoveFirstAndMiddle(),
    caseEmptyBody(),
  ]
  const failures = cases.filter(item => !item.ok)
  Script.exit({
    ok: failures.length === 0,
    passed: cases.length - failures.length,
    failed: failures.length,
    failures,
  })
}

main()
