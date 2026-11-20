/**
 * Style-preserving patcher for `*.xcstrings` files.
 *
 * Xcode rewrites these files with its own formatting (`"key" : value`,
 * alphabetically sorted keys, 2-space indent). Re-serializing a parsed object
 * would reorder / reformat tens of thousands of existing lines, producing an
 * unreviewable diff. So instead we scan the raw JSON text and splice in only
 * the new `localizations` entries (or remove stale entries) as text edits.
 *
 * Safety: callers must verify the patched text by parsing it and comparing it
 * with the expected object (`verifyPatch`). Nothing here mutates the input.
 */

export type PatchStyle = {
  /** `" : "` for Xcode-written files, `": "` for compact files. */
  colon: string
  /** One indentation level (all known files use two spaces). */
  indent: string
}

export type LocaleInsert = { locale: string; value: string }

export type PatchPlan = {
  /** entry key -> localizations to add (missing ones only). */
  insertions: Record<string, LocaleInsert[]>
  /** entry key -> existing localizations whose value must be rewritten. */
  replacements?: Record<string, LocaleInsert[]>
  /** entry keys to delete entirely (stale entries). */
  removals: string[]
}

type Member = {
  key: string
  keyStart: number
  keyEnd: number
  valueStart: number
  valueEnd: number
  /** Index of the ',' that follows this member, or null for the last member. */
  commaPos: number | null
}

type ScannedObject = {
  open: number
  close: number
  members: Member[]
}

type Edit = { start: number; end: number; text: string }

const QUOTE = 34 // '"'

export function detectStyle(raw: string): PatchStyle {
  const head = raw.slice(0, 4000)
  return {
    colon: /"\s+:/.test(head) ? " : " : ": ",
    indent: "  ",
  }
}

function skipWhitespace(text: string, index: number): number {
  let i = index
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (code === 32 || code === 9 || code === 10 || code === 13) {
      i++
      continue
    }
    break
  }
  return i
}

function scanString(text: string, index: number): { value: string; end: number } {
  // index points at the opening quote.
  let i = index + 1
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (code === 92) {
      i += 2
      continue
    }
    if (code === QUOTE) {
      break
    }
    i++
  }
  const end = i + 1
  let value: string
  try {
    value = JSON.parse(text.slice(index, end)) as string
  } catch {
    value = text.slice(index + 1, i)
  }
  return { value, end }
}

function scanArrayEnd(text: string, open: number): number {
  let depth = 0
  let i = open
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      i = scanString(text, i).end
      continue
    }
    if (ch === "[") {
      depth++
    } else if (ch === "]") {
      depth--
      if (depth === 0) {
        return i + 1
      }
    }
    i++
  }
  return text.length
}

function scanValueEnd(text: string, index: number): number {
  const ch = text[index]
  if (ch === '"') {
    return scanString(text, index).end
  }
  if (ch === "{") {
    return scanObject(text, index).close + 1
  }
  if (ch === "[") {
    return scanArrayEnd(text, index)
  }
  let i = index
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (code === 44 || code === 125 || code === 93 || code === 32 || code === 10 || code === 13 || code === 9) {
      break
    }
    i++
  }
  return i
}

function scanObject(text: string, open: number): ScannedObject {
  const members: Member[] = []
  let i = open + 1
  let close = text.length - 1
  while (i < text.length) {
    i = skipWhitespace(text, i)
    const ch = text[i]
    if (ch === "}") {
      close = i
      break
    }
    if (ch === ",") {
      i++
      continue
    }
    if (ch !== '"') {
      // Malformed input; bail out so the caller can fall back.
      close = i
      break
    }
    const keyStart = i
    const scanned = scanString(text, i)
    const keyEnd = scanned.end
    i = skipWhitespace(text, keyEnd)
    if (text[i] === ":") {
      i++
    }
    i = skipWhitespace(text, i)
    const valueStart = i
    const valueEnd = scanValueEnd(text, i)
    i = skipWhitespace(text, valueEnd)
    let commaPos: number | null = null
    if (text[i] === ",") {
      commaPos = i
      i++
    }
    members.push({ key: scanned.value, keyStart, keyEnd, valueStart, valueEnd, commaPos })
  }
  return { open, close, members }
}

function findMember(object: ScannedObject, key: string): Member | undefined {
  return object.members.find(member => member.key === key)
}

function lineStart(text: string, index: number): number {
  const nl = text.lastIndexOf("\n", index - 1)
  return nl < 0 ? 0 : nl + 1
}

/** Leading whitespace of the line that contains `index`. */
function indentAt(text: string, index: number): string {
  const start = lineStart(text, index)
  let end = start
  while (end < text.length) {
    const ch = text[end]
    if (ch === " " || ch === "\t") {
      end++
      continue
    }
    break
  }
  return text.slice(start, end)
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function localeBlock(insert: LocaleInsert, indent: string, style: PatchStyle): string {
  const i1 = indent + style.indent
  const i2 = i1 + style.indent
  return [
    `${indent}${quote(insert.locale)}${style.colon}{`,
    `${i1}"stringUnit"${style.colon}{`,
    `${i2}"state"${style.colon}"translated",`,
    `${i2}"value"${style.colon}${quote(insert.value)}`,
    `${i1}}`,
    `${indent}}`,
  ].join("\n")
}

function applyEdits(raw: string, edits: Edit[]): string {
  if (edits.length === 0) {
    return raw
  }
  const sorted = edits.slice().sort((a, b) => b.start - a.start)
  let out = raw
  for (const edit of sorted) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  }
  return out
}

type Block = { key: string; render: (indent: string) => string }

/**
 * Build insertions for a JSON object, keeping the caller's sorted order:
 * each new key is spliced immediately before the first existing member whose
 * key sorts after it, and leftovers are appended after the last member.
 */
function buildInsertions(
  text: string,
  object: ScannedObject,
  blocks: Block[],
  style: PatchStyle,
): Edit[] {
  if (blocks.length === 0) {
    return []
  }
  const sorted = blocks
    .slice()
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  if (object.members.length === 0) {
    const parentIndent = indentAt(text, object.open)
    const indent = parentIndent + style.indent
    const rendered = sorted.map(block => block.render(indent)).join(",\n")
    return [{ start: object.open + 1, end: object.open + 1, text: `\n${rendered}\n${parentIndent}` }]
  }

  const indent = indentAt(text, object.members[0].keyStart)
  const groups = new Map<Member | null, Block[]>()
  for (const block of sorted) {
    const anchor = object.members.find(member => member.key > block.key) ?? null
    const bucket = groups.get(anchor) ?? []
    bucket.push(block)
    groups.set(anchor, bucket)
  }

  const edits: Edit[] = []
  for (const [anchor, bucket] of groups) {
    if (anchor) {
      const at = lineStart(text, anchor.keyStart)
      const rendered = bucket.map(block => `${block.render(indent)},\n`).join("")
      edits.push({ start: at, end: at, text: rendered })
    } else {
      const last = object.members[object.members.length - 1]
      const rendered = bucket.map(block => block.render(indent)).join(",\n")
      edits.push({ start: last.valueEnd, end: last.valueEnd, text: `,\n${rendered}` })
    }
  }
  return edits
}

/** Remove a member (including its comma and the line it occupies). */
function removalEdit(text: string, object: ScannedObject, member: Member): Edit {
  const index = object.members.indexOf(member)
  const start = lineStart(text, member.keyStart)
  if (member.commaPos != null) {
    let end = member.commaPos + 1
    if (text[end] === "\n") {
      end++
    }
    return { start, end, text: "" }
  }
  const previous = index > 0 ? object.members[index - 1] : undefined
  if (previous && previous.commaPos != null) {
    return { start: previous.commaPos, end: member.valueEnd, text: "" }
  }
  return { start: object.open + 1, end: member.valueEnd, text: "" }
}

function localeValueObject(value: string, indent: string, style: PatchStyle): string {
  const i1 = indent + style.indent
  const i2 = i1 + style.indent
  return [
    "{",
    `${i1}"stringUnit"${style.colon}{`,
    `${i2}"state"${style.colon}"translated",`,
    `${i2}"value"${style.colon}${quote(value)}`,
    `${i1}}`,
    `${indent}}`,
  ].join("\n")
}

function localizationsBlock(
  inserts: LocaleInsert[],
  indent: string,
  style: PatchStyle,
): string {
  const sorted = inserts
    .slice()
    .sort((a, b) => (a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0))
  const inner = sorted.map(insert => localeBlock(insert, indent + style.indent, style)).join(",\n")
  return [`${indent}"localizations"${style.colon}{`, inner, `${indent}}`].join("\n")
}

/**
 * Splice `plan` into `raw`. Returns the original string when nothing changes.
 * The caller must verify the result before writing it to disk.
 */
export function patchXcstrings(raw: string, plan: PatchPlan): string {
  const rootOpen = skipWhitespace(raw, 0)
  if (raw[rootOpen] !== "{") {
    throw new Error("not a JSON object")
  }
  const style = detectStyle(raw)
  const root = scanObject(raw, rootOpen)
  const stringsMember = findMember(root, "strings")
  if (!stringsMember) {
    throw new Error('missing "strings"')
  }
  const strings = scanObject(raw, stringsMember.valueStart)

  const edits: Edit[] = []
  const removeSet = new Set(plan.removals)

  for (const member of strings.members) {
    if (!removeSet.has(member.key)) {
      continue
    }
    edits.push(removalEdit(raw, strings, member))
  }

  for (const member of strings.members) {
    const inserts = plan.insertions[member.key] ?? []
    const replacements = plan.replacements?.[member.key] ?? []
    if (inserts.length === 0 && replacements.length === 0) {
      continue
    }
    const entry = scanObject(raw, member.valueStart)
    const localizations = findMember(entry, "localizations")

    if (localizations) {
      const container = scanObject(raw, localizations.valueStart)
      const existing = new Set(container.members.map(item => item.key))
      const missing = inserts.filter(item => !existing.has(item.locale))
      if (missing.length === 0 && replacements.length === 0) {
        continue
      }
      edits.push(
        ...buildInsertions(
          raw,
          container,
          missing.map(item => ({
            key: item.locale,
            render: (indent: string) => localeBlock(item, indent, style),
          })),
          style,
        ),
      )
      for (const replacement of replacements) {
        const target = container.members.find(item => item.key === replacement.locale)
        if (!target) {
          continue
        }
        edits.push({
          start: target.valueStart,
          end: target.valueEnd,
          text: localeValueObject(replacement.value, indentAt(raw, target.keyStart), style),
        })
      }
      continue
    }

    // Entry has no `localizations` yet: add the whole member.
    const entryIndent = entry.members.length > 0
      ? indentAt(raw, entry.members[0].keyStart)
      : indentAt(raw, member.keyStart) + style.indent
    const block = localizationsBlock(inserts, entryIndent, style)

    const shouldTranslate = findMember(entry, "shouldTranslate")
    if (shouldTranslate) {
      const at = lineStart(raw, shouldTranslate.keyStart)
      edits.push({ start: at, end: at, text: `${block},\n` })
    } else if (entry.members.length === 0) {
      // Body may already contain whitespace (`{\n    }`); replace it entirely so
      // no stray indentation line is left behind.
      edits.push({
        start: entry.open + 1,
        end: entry.close,
        text: `\n${block}\n${indentAt(raw, member.keyStart)}`,
      })
    } else {
      const last = entry.members[entry.members.length - 1]
      edits.push({ start: last.valueEnd, end: last.valueEnd, text: `,\n${block}` })
    }
  }

  return applyEdits(raw, edits)
}

/** Deep equality for JSON values (objects, arrays, primitives). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (typeof a !== typeof b) {
    return false
  }
  if (a === null || b === null) {
    return false
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false
    }
    return a.every((item, index) => jsonEqual(item, b[index]))
  }
  if (typeof a === "object") {
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) {
      return false
    }
    return leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key) && jsonEqual(left[key], right[key]))
  }
  return false
}

/** Verify that `text` parses and deep-equals `expected`. */
export function verifyPatch(expected: unknown, text: string): { ok: boolean; error?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!jsonEqual(expected, parsed)) {
    return { ok: false, error: "patched JSON does not match the expected object" }
  }
  return { ok: true }
}
