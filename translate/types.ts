export type LanguageOption = {
  code: string
  label: string
  promptName: string
}

export type BuiltInTranslationEngineKind =
  | "apple_intelligence"
  | "assistant"
  | "ai_translate"
  | "system_translation"
  | "google_translate"

export type KnownTranslationEngineKind =
  | BuiltInTranslationEngineKind

export type AiApiCompatibilityMode =
  | "custom"
  | "newapi"
  | "openai"
  | "gemini"
  | "siliconflow"
  | "qwen"

export type TranslationEngineKind =
  | KnownTranslationEngineKind
  | "ai_api"
  | "deeplx"
  | "custom_api"

export type CustomApiHttpMethod = "GET" | "POST"

export type TranslationEngineOption = {
  id: KnownTranslationEngineKind
  label: string
  systemImage: string
  isDefault?: boolean
}

export type TranslationEngineConfig = {
  apiKey?: string
  compatibilityMode?: AiApiCompatibilityMode
  baseUrl?: string
  model?: string
  assistantProviderId?: "openai" | "gemini" | "anthropic" | "deepseek" | "openrouter" | "custom"
  assistantCustomProvider?: string
  assistantModelId?: string
  // 「AI 翻译」引擎选中的模型池条目 id（仅存本引擎，不写全局激活模型，与键盘解耦）。
  selectedPoolEntryId?: string
  // 通用自定义翻译接口（custom_api）：用模板 + 提取路径接入任意传统翻译 API
  httpMethod?: CustomApiHttpMethod
  requestUrl?: string
  requestHeaders?: string
  requestBody?: string
  responsePath?: string
  langMap?: string
}

export type TranslatorEngineEntry = {
  id: string
  kind: TranslationEngineKind
  label: string
  systemImage: string
  enabled: boolean
  isBuiltIn: boolean
  config?: TranslationEngineConfig
}

export type TranslatorSettings = {
  engines: TranslatorEngineEntry[]
  defaultTargetLanguageCode: string
  defaultSourceLanguageCode: string
}

export type TranslationRequest = {
  sourceText: string
  sourceLanguageCode: string
  targetLanguageCode: string
}

export type TranslationResult = {
  translatedText: string
}

export type TranslationProgressCallbacks = {
  onPartialText?: (text: string) => void | Promise<void>
}

export type EngineTranslationState = {
  engineId: string
  engineName: string
  systemImage: string
  translatedText: string
  errorText: string
  isTranslating: boolean
}
