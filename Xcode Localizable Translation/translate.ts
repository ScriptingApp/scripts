/**
 * Translation request layer.
 *
 * Throttling and concurrency are handled by the scheduler — this module only
 * performs a single structured-data request (with internal retry on malformed
 * responses) and supports cooperative cancellation.
 *
 * The result is an array aligned with `contents` (same length, same order).
 * Callers that need source -> translation mapping build it themselves, so
 * duplicate source strings cannot collapse entries.
 */

export type ProviderSelection = {
  provider: Assistant.Provider
  modelId?: string
}

export type TranslateSignal = {
  readonly isCancelled: boolean
}

/** Prompt profile: generic UI copy or Scripting's xcstrings-specific rules. */
export type TranslationProfile = "plain" | "xcstrings"

export type TranslateRequest = {
  contents: string[]
  language: string
  selection: ProviderSelection
  profile?: TranslationProfile
  /** Extra glossary / context appended to the prompt. */
  context?: string
  signal?: TranslateSignal
}

const MAX_RETRIES = 3

const schema: JSONSchemaObject = {
  type: "object",
  properties: {
    translations: {
      required: true,
      type: "array",
      items: {
        type: "string",
        description: "Translated content",
        required: true,
      },
      description: "Translated contents array in the same order as input",
    },
  },
  description: "The translated contents json object",
}

const COMMON_RULES = `1.保留所有占位符与格式说明符（如 %@、%d、%1$s、${"${name}"}、{{name}}、<tag>）以及换行
2.保留 URL、文件路径、代码标识符、API 名称，不要翻译
3.只输出翻译结果，不要添加解释或前后缀`

function buildXcstringsPrompt(
  contents: string[],
  language: string,
  context?: string,
): string {
  return `以下是Scripting iOS app的 Localizable.xcstrings 文件里的需要翻译的文案，每个<content>标签为一条文案，请将它们翻译为${language}，请遵循以下几点规则：
  1.保留文案中的变量
  2.Scripting指Scripting App，不要翻译为"脚本"
  3.Assistant指Scripting Assistant，中文是"智能助手"的意思，按这个意思翻译
  4.Scripting App是一个可以在iOS设备上编写脚本的app，翻译的内容需要专业和准确
  ${context ? `5.额外上下文：${context}` : ""}

  文案内容:\n
  ${contents.map(item => `<content>${item}</content>`).join("\n")}`
}

function buildPlainPrompt(
  contents: string[],
  language: string,
  context?: string,
): string {
  return `请将以下内容翻译为${language}。请遵循：
${COMMON_RULES}
${context ? `4.额外上下文：${context}` : ""}

每个<content>标签为一条独立内容，请逐条翻译并保持顺序：
${contents.map(item => `<content>${item}</content>`).join("\n")}`
}

function buildPrompt(request: TranslateRequest): string {
  const { contents, language, profile = "plain", context } = request
  return profile === "xcstrings"
    ? buildXcstringsPrompt(contents, language, context)
    : buildPlainPrompt(contents, language, context)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class TranslationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TranslationError"
  }
}

/**
 * Translate a batch of contents into `language`.
 * Returns an array aligned with `contents`, or null when cancelled.
 */
export async function translate(
  request: TranslateRequest,
  retry = 0,
): Promise<string[] | null> {
  const { contents, language, selection, signal } = request

  if (signal?.isCancelled) {
    return null
  }

  const prompt = buildPrompt(request)

  try {
    const res = await Assistant.requestStructuredData<{
      translations: string[]
    }>(prompt, schema, {
      provider: selection.provider,
      modelId: selection.modelId,
    })

    if (signal?.isCancelled) {
      return null
    }

    if (!res || !Array.isArray(res.translations)) {
      throw new TranslationError("model returned an invalid translations payload")
    }

    if (res.translations.length !== contents.length) {
      throw new TranslationError(
        `model returned ${res.translations.length} translations, expected ${contents.length}`,
      )
    }

    return res.translations
  } catch (e) {
    if (signal?.isCancelled) {
      return null
    }
    console.error(`[${language}] ${e}`)

    if (retry < MAX_RETRIES) {
      const next = retry + 1
      await delay(300 * Math.pow(2, retry))
      if (signal?.isCancelled) {
        return null
      }
      console.error(`[${language}] Retrying... ${next}/${MAX_RETRIES}`)
      return translate(request, next)
    }

    // Retries exhausted: propagate the real error so callers can report it.
    throw e instanceof Error ? e : new TranslationError(String(e))
  }
}
