import type {
  TranslationEngineConfig,
  TranslationProgressCallbacks,
  TranslationRequest,
  TranslationResult,
} from "../types"
import { translateChunkedText } from "./translation_chunking"

const ASSISTANT_TRANSLATION_SYSTEM_PROMPT = [
  "You are a translation engine for an iOS translation panel.",
  "Always translate faithfully and naturally.",
  "Return translated text only.",
  "Do not answer the text, do not summarize, and do not add commentary.",
  "Preserve paragraph breaks, bullet structure, code blocks, URLs, emoji, and numbers.",
  "Do not omit, shorten, or paraphrase away any part of the input.",
  "Always output the full translation in the requested target language.",
  "Do not include the <text> or </text> tags in the output.",
].join(" ")

function getRawAssistantAvailabilityValue() {
  if (typeof Assistant === "undefined") {
    return undefined
  }

  return (Assistant as any).isAvailable
}

export function isAssistantTranslationAvailable() {
  try {
    const raw = getRawAssistantAvailabilityValue()
    return typeof raw === "function" ? !!raw.call(Assistant) : !!raw
  } catch {
    return false
  }
}

function normalizeAssistantTranslation(content: string) {
  const normalized = String(content ?? "")
    .replace(/^```[\w-]*\n?/, "")
    .replace(/\n?```$/, "")
    .replace(/^(?:\s*<text>\s*)+/i, "")
    .replace(/(?:\s*<\/text>\s*)+$/i, "")
    .trim()

  const lines = normalized.split("\n")
  while (lines.length && lines[0].trim().toLowerCase() === "<text>") {
    lines.shift()
  }
  while (lines.length && lines[lines.length - 1].trim().toLowerCase() === "</text>") {
    lines.pop()
  }

  return lines.join("\n").trim()
}

export function createAssistantTranslationEngine(config?: TranslationEngineConfig) {
  const providerId = config?.assistantProviderId ?? "app_default"
  const customProvider = String(config?.assistantCustomProvider ?? "").trim()
  const modelId = String(config?.assistantModelId ?? "").trim()
  // provider 取值（据官方 Assistant 文档）：内置名 / { custom: 名称 } / 省略（用 App 默认）。
  // 纯字符串自定义名（如 "agnes1"）直传会被 App 当作内置名报 unknown api provider，
  // 所以除内置名外，任何非空字符串都必须包成 { custom: 名称 }。
  // 三种 config 情况统一兜底：
  // - app_default / 空：省略 provider，走 App 模型选择器当前默认供应商。
  // - custom：取 assistantCustomProvider 作为供应商标识。
  // - 内置名（openai/gemini/anthropic/deepseek/openrouter）：直传。
  // - 其它裸名（如系统翻译路径里 assistantProviderId 直接存了 "agnes1"）：当作自定义供应商包成 { custom: 名称 }。
  const BUILTIN_PROVIDERS = ["openai", "gemini", "anthropic", "deepseek", "openrouter"]
  const trimmedProviderId = String(providerId ?? "").trim()
  let provider: string | { custom: string } | undefined
  if (!trimmedProviderId || trimmedProviderId === "app_default") {
    provider = undefined
  } else if (trimmedProviderId === "custom") {
    provider = customProvider ? { custom: customProvider } : undefined
  } else if (BUILTIN_PROVIDERS.includes(trimmedProviderId)) {
    provider = trimmedProviderId
  } else {
    provider = { custom: trimmedProviderId }
  }

  async function translateSingle(
    request: TranslationRequest,
    callbacks?: TranslationProgressCallbacks
  ): Promise<TranslationResult> {
    const stream = await Assistant.requestStreaming({
      systemPrompt: ASSISTANT_TRANSLATION_SYSTEM_PROMPT,
      provider,
      modelId: modelId || undefined,
      messages: {
        role: "user",
        content: [
          `Source language: ${request.sourceLanguageCode}`,
          `Target language: ${request.targetLanguageCode}`,
          "Translate the following text:",
          "",
          "<text>",
          request.sourceText,
          "</text>",
        ].join("\n"),
      },
    })

    let translatedText = ""
    let lastPartialText = ""

    for await (const chunk of stream as any) {
      if (chunk?.type !== "text") continue
      translatedText += String(chunk.content ?? "")

      const partialText = normalizeAssistantTranslation(translatedText)
      if (partialText && partialText !== lastPartialText) {
        lastPartialText = partialText
        await callbacks?.onPartialText?.(partialText)
      }
    }

    const normalized = normalizeAssistantTranslation(translatedText)
    if (!normalized) {
      throw new Error("Assistant 没有返回可用译文。")
    }

    return {
      translatedText: normalized,
    }
  }

  return {
    translateSingle,

    async translate(
      request: TranslationRequest,
      callbacks?: TranslationProgressCallbacks
    ): Promise<TranslationResult> {
      return await translateChunkedText(
        request,
        {
          maxChunkLength: 1400,
          concurrency: 2,
          translateChunk: async (chunkRequest, chunkCallbacks) => (
            await translateSingle(chunkRequest, chunkCallbacks)
          ),
        },
        callbacks
      )
    },
  }
}
