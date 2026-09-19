import { LANGUAGE_OPTIONS, TRANSLATION_ENGINE_OPTIONS } from "../constants"
import type {
  BuiltInTranslationEngineKind,
  KnownTranslationEngineKind,
  TranslationEngineConfig,
  TranslatorEngineEntry,
  TranslatorSettings,
} from "../types"
import { isAssistantTranslationAvailable } from "./assistant_translation_engine"
import { isLocalTranslationAvailable } from "./translation_engine"
import { refreshPoolFromSettings } from "./model_pool"

const STORAGE_KEY = "translator_settings_v2"
const DEFAULT_TARGET_LANGUAGE_CODE = "zh-Hans"
const DEFAULT_SOURCE_LANGUAGE_CODE = "auto"

function builtInEntry(kind: KnownTranslationEngineKind): TranslatorEngineEntry {
  const option = TRANSLATION_ENGINE_OPTIONS.find((item) => item.id === kind)!
  const defaultEnabled = option.isDefault ?? false
  return {
    id: kind,
    kind,
    label: option.label,
    systemImage: option.systemImage,
    enabled: kind === "apple_intelligence"
      ? defaultEnabled && isLocalTranslationAvailable()
      : defaultEnabled,
    isBuiltIn: true,
    config: kind === "assistant"
      ? {
          assistantProviderId: "openai",
          assistantCustomProvider: "",
          assistantModelId: "",
        }
      : undefined,
  }
}

function createDefaultSettings(): TranslatorSettings {
  return {
    defaultTargetLanguageCode: DEFAULT_TARGET_LANGUAGE_CODE,
    defaultSourceLanguageCode: DEFAULT_SOURCE_LANGUAGE_CODE,
    engines: [
      builtInEntry("apple_intelligence"),
      builtInEntry("assistant"),
      builtInEntry("ai_translate"),
      builtInEntry("system_translation"),
      builtInEntry("google_translate"),
    ],
  }
}

const REQUIRED_BUILT_INS: BuiltInTranslationEngineKind[] = [
  "apple_intelligence",
  "assistant",
  "ai_translate",
  "system_translation",
  "google_translate",
]

function storage() {
  return (globalThis as any).Storage
}

function readPrivateSettings(st: any): TranslatorSettings | null | undefined {
  return st?.get?.(STORAGE_KEY) as TranslatorSettings | null | undefined
}

function readSharedSettings(st: any): TranslatorSettings | null | undefined {
  return st?.get?.(STORAGE_KEY, { shared: true }) as TranslatorSettings | null | undefined
}

function writePrivateSettings(st: any, settings: TranslatorSettings) {
  try {
    return typeof st?.set === "function" && st.set(STORAGE_KEY, settings) !== false
  } catch {
    return false
  }
}

function removeSharedSettings(st: any) {
  try {
    st?.remove?.(STORAGE_KEY, { shared: true })
  } catch { }
}

function defaultBuiltInMap() {
  return new Map(REQUIRED_BUILT_INS.map((kind) => [kind, builtInEntry(kind)]))
}

function normalizeDefaultTargetLanguageCode(code: unknown) {
  const normalized = String(code ?? "").trim()
  if (LANGUAGE_OPTIONS.some((item) => item.code === normalized)) {
    return normalized
  }
  return DEFAULT_TARGET_LANGUAGE_CODE
}

function normalizeDefaultSourceLanguageCode(code: unknown) {
  const normalized = String(code ?? "").trim()
  if (normalized === "auto" || LANGUAGE_OPTIONS.some((item) => item.code === normalized)) {
    return normalized
  }
  return DEFAULT_SOURCE_LANGUAGE_CODE
}

function isKnownEngineKind(kind: unknown): kind is KnownTranslationEngineKind {
  return TRANSLATION_ENGINE_OPTIONS.some((item) => item.id === kind)
}

function normalizeEngineSystemImage(value: unknown, fallback: string) {
  const normalized = String(value ?? fallback).trim()
  if (!normalized || normalized === "network") return fallback
  return normalized
}

function normalizeExternalEngineEntry(
  raw: Partial<TranslatorEngineEntry>,
  kind: "ai_api" | "deeplx" | "custom_api",
  fallbackLabel: string,
  fallbackSystemImage: string,
  fallbackIdPrefix: string
): TranslatorEngineEntry {
  return {
    id: String(raw.id ?? "").trim() || `${fallbackIdPrefix}_${Date.now().toString(36)}`,
    kind,
    label: String(raw.label ?? "").trim() || fallbackLabel,
    systemImage: normalizeEngineSystemImage(raw.systemImage, fallbackSystemImage),
    enabled: raw.enabled ?? false,
    isBuiltIn: false,
    config: raw.config,
  }
}

function normalizeEngineEntry(raw: Partial<TranslatorEngineEntry> | null | undefined): TranslatorEngineEntry | null {
  if (!raw) return null

  if (raw.kind === "ai_api") {
    return normalizeExternalEngineEntry(raw, "ai_api", "AI 接口", "sparkles", "ai_api")
  }

  if (raw.kind === "deeplx") {
    return normalizeExternalEngineEntry(raw, "deeplx", "DeepLX", "d.circle", "deeplx")
  }

  if (raw.kind === "custom_api") {
    return normalizeExternalEngineEntry(raw, "custom_api", "自定义接口", "text.badge.plus", "custom_api")
  }

  if (isKnownEngineKind(raw.kind)) {
    const base = builtInEntry(raw.kind)
    return {
      ...base,
      enabled: raw.enabled ?? base.enabled,
      config: raw.kind === "assistant"
        ? {
            ...base.config,
            ...raw.config,
          }
        : raw.config,
    }
  }

  return null
}

function applyAvailabilityRules(entry: TranslatorEngineEntry): TranslatorEngineEntry {
  if (entry.kind === "apple_intelligence" && !isLocalTranslationAvailable()) {
    return {
      ...entry,
      enabled: false,
    }
  }

  if (entry.kind === "assistant") {
    if (!isAssistantTranslationAvailable()) {
      return {
        ...entry,
        enabled: false,
      }
    }
  }

  return entry
}

function applyAvailabilityRulesToSettings(settings: TranslatorSettings): TranslatorSettings {
  return {
    defaultTargetLanguageCode: normalizeDefaultTargetLanguageCode(settings.defaultTargetLanguageCode),
    defaultSourceLanguageCode: normalizeDefaultSourceLanguageCode(settings.defaultSourceLanguageCode),
    engines: settings.engines.map((entry) => applyAvailabilityRules(entry)),
  }
}

function migrateLegacySettings(raw: any): TranslatorSettings | null {
  if (!raw || typeof raw !== "object") return null
  if (!Array.isArray(raw.engineOrder) || typeof raw.engineEnabled !== "object") return null

  const engines: TranslatorEngineEntry[] = []
  const order = raw.engineOrder as string[]
  const enabled = raw.engineEnabled as Record<string, boolean>

  for (const kind of order) {
    if (kind !== "apple_intelligence" && kind !== "system_translation") continue
    const entry = builtInEntry(kind)
    entry.enabled = enabled[kind] ?? entry.enabled
    engines.push(entry)
  }

  for (const option of TRANSLATION_ENGINE_OPTIONS) {
    if (!engines.find((item) => item.kind === option.id)) {
      const entry = builtInEntry(option.id)
      entry.enabled = enabled[option.id] ?? entry.enabled
      engines.push(entry)
    }
  }

  return { engines, defaultTargetLanguageCode: DEFAULT_TARGET_LANGUAGE_CODE, defaultSourceLanguageCode: DEFAULT_SOURCE_LANGUAGE_CODE }
}

export function normalizeTranslatorSettings(raw?: Partial<TranslatorSettings> | null): TranslatorSettings {
  const legacy = migrateLegacySettings(raw)
  if (legacy) {
    return applyAvailabilityRulesToSettings({
      ...legacy,
      defaultTargetLanguageCode: DEFAULT_TARGET_LANGUAGE_CODE,
    })
  }

  const defaults = defaultBuiltInMap()
  const normalized: TranslatorEngineEntry[] = []

  // 这里只兜底补回必须保留的内置引擎，像 Google 这类可删项不再偷偷加回来。
  for (const item of Array.isArray(raw?.engines) ? raw.engines : []) {
    const entry = normalizeEngineEntry(item)
    if (!entry) continue

    if (entry.isBuiltIn) {
      defaults.delete(entry.kind as BuiltInTranslationEngineKind)
    }

    if (!normalized.find((existing) => existing.id === entry.id)) {
      normalized.push(applyAvailabilityRules(entry))
    }
  }

  for (const entry of defaults.values()) {
    normalized.push(applyAvailabilityRules(entry))
  }

  return applyAvailabilityRulesToSettings({
    defaultTargetLanguageCode: normalizeDefaultTargetLanguageCode(raw?.defaultTargetLanguageCode),
    defaultSourceLanguageCode: normalizeDefaultSourceLanguageCode(raw?.defaultSourceLanguageCode),
    engines: normalized,
  })
}

export function loadTranslatorSettings(): TranslatorSettings {
  const st = storage()
  if (!st?.get) {
    return applyAvailabilityRulesToSettings(createDefaultSettings())
  }

  const privateRaw = readPrivateSettings(st)
  if (privateRaw != null) {
    removeSharedSettings(st)
    return normalizeTranslatorSettings(privateRaw)
  }

  const sharedRaw = readSharedSettings(st)
  if (sharedRaw != null) {
    // 旧版本把配置写进 shared 域，这里迁回脚本私有域，并顺手清掉旧数据。
    const migrated = normalizeTranslatorSettings(sharedRaw)
    if (writePrivateSettings(st, migrated)) removeSharedSettings(st)
    return migrated
  }

  removeSharedSettings(st)
  return applyAvailabilityRulesToSettings(createDefaultSettings())
}

export function saveTranslatorSettings(settings: TranslatorSettings) {
  const st = storage()
  if (!st?.set) return
  const normalized = normalizeTranslatorSettings(settings)
  if (writePrivateSettings(st, normalized)) {
    removeSharedSettings(st)
  }
  // 保存设置 = 异步刷新 shared 模型池：把每个 AI 接口展开为其 /v1/models 的全部模型，
  // 让选择器/键盘立即读到最新「供应商×模型」大表（池为派生副本，私有设置仍是唯一真源）。
  try {
    void refreshPoolFromSettings(normalized).catch(() => {})
  } catch {}
}

export function updateEngineEnabled(
  settings: TranslatorSettings,
  engineId: string,
  enabled: boolean
): TranslatorSettings {
  return normalizeTranslatorSettings({
    ...settings,
    engines: settings.engines.map((item) => (
      item.id === engineId
        ? { ...item, enabled }
        : item
    )),
  })
}

export function updateDefaultTargetLanguage(
  settings: TranslatorSettings,
  code: string
): TranslatorSettings {
  return normalizeTranslatorSettings({
    ...settings,
    defaultTargetLanguageCode: code,
  })
}

export function updateDefaultSourceLanguage(
  settings: TranslatorSettings,
  code: string
): TranslatorSettings {
  return normalizeTranslatorSettings({
    ...settings,
    defaultSourceLanguageCode: code,
  })
}

export function updateEngineConfig(
  settings: TranslatorSettings,
  engineId: string,
  config: TranslationEngineConfig
): TranslatorSettings {
  return normalizeTranslatorSettings({
    ...settings,
    engines: settings.engines.map((item) => (
      item.id === engineId
        ? { ...item, config: { ...config } }
        : item
    )),
  })
}

export function reorderEngines(
  settings: TranslatorSettings,
  indices: number[],
  newOffset: number
): TranslatorSettings {
  const movingItems = indices.map((index) => settings.engines[index]).filter(Boolean)
  const next = settings.engines.filter((_, index) => !indices.includes(index))
  next.splice(newOffset, 0, ...movingItems)

  return normalizeTranslatorSettings({
    ...settings,
    engines: next,
  })
}

export function getExecutableEngines(settings: TranslatorSettings) {
  return settings.engines
}

export function addAiApiEngine(settings: TranslatorSettings): TranslatorSettings {
  return normalizeTranslatorSettings({
    ...settings,
    engines: [
      ...settings.engines,
      {
        id: `ai_api_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        kind: "ai_api",
        label: "AI 接口",
        systemImage: "sparkles",
        enabled: false,
        isBuiltIn: false,
        config: {
          compatibilityMode: "custom",
          baseUrl: "",
          apiKey: "",
          model: "",
        },
      },
    ],
  })
}

export function removeEngine(
  settings: TranslatorSettings,
  engineId: string
): TranslatorSettings {
  return normalizeTranslatorSettings({
    ...settings,
    engines: settings.engines.filter((item) => item.id !== engineId),
  })
}

export function addDeepLxEngine(settings: TranslatorSettings): TranslatorSettings {
  return normalizeTranslatorSettings({
    ...settings,
    engines: [
      ...settings.engines,
      {
        id: `deeplx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        kind: "deeplx",
        label: "DeepLX",
        systemImage: "d.circle",
        enabled: false,
        isBuiltIn: false,
        config: {
          baseUrl: "",
        },
      },
    ],
  })
}

export type CustomApiPreset = {
  id: string
  label: string
  note: string
  config: Partial<TranslationEngineConfig>
}

// 预置几家主流、无需签名算法（可直接用静态 URL/Body 模板）的传统翻译接口。
// 用户选定后会预填模板，只需把 YOUR_KEY 换成自己的密钥即可（MyMemory 免密钥）。
export const CUSTOM_API_PRESETS: CustomApiPreset[] = [
  {
    id: "mymemory",
    label: "MyMemory（免费）",
    note: "免密钥的免费翻译接口，适合少量文本，src|tgt 用 ISO 代码。",
    config: {
      httpMethod: "GET",
      requestUrl: "https://api.mymemory.translated.net/get?q={{text}}&langpair={{sourceLang}}|{{targetLang}}",
      requestHeaders: "",
      requestBody: "",
      responsePath: "responseData.translatedText",
      langMap: "auto=Auto|zh-Hans=zh-CN|zh-Hant=zh-TW",
    },
  },
  {
    id: "google_cloud",
    label: "Google 云翻译",
    note: "在 URL 末尾把 YOUR_KEY 换成你的 API Key（v2 接口）。",
    config: {
      httpMethod: "POST",
      requestUrl: "https://translation.googleapis.com/language/translate/v2?key=YOUR_KEY",
      requestHeaders: "Content-Type: application/json",
      requestBody: '{"q":"{{text}}","source":"{{sourceLang}}","target":"{{targetLang}}","format":"text"}',
      responsePath: "data.translations.0.translatedText",
      langMap: "zh-Hans=zh-CN|zh-Hant=zh-TW",
    },
  },
  {
    id: "microsoft",
    label: "Microsoft 翻译",
    note: "在请求头把 YOUR_KEY 换成订阅密钥，区域需要时再加一行请求头。",
    config: {
      httpMethod: "POST",
      requestUrl: "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to={{targetLang}}",
      requestHeaders: "Ocp-Apim-Subscription-Key: YOUR_KEY\nContent-Type: application/json",
      requestBody: '[{"text":"{{text}}"}]',
      responsePath: "0.translations.0.text",
      langMap: "zh-Hans=zh-Hans|zh-Hant=zh-Hant",
    },
  },
  {
    id: "libretranslate",
    label: "LibreTranslate",
    note: "自建/公共实例，把域名换成你的服务地址；部分实例需要 api_key。",
    config: {
      httpMethod: "POST",
      requestUrl: "https://libretranslate.com/translate",
      requestHeaders: "Content-Type: application/json",
      requestBody: '{"q":"{{text}}","source":"{{sourceLang}}","target":"{{targetLang}}","format":"text"}',
      responsePath: "translatedText",
      langMap: "zh-Hans=zh-Hans|zh-Hant=zh-Hant",
    },
  },
]

export function buildCustomApiConfig(preset?: CustomApiPreset): TranslationEngineConfig {
  if (!preset) {
    return {
      httpMethod: "GET",
      requestUrl: "",
      requestHeaders: "",
      requestBody: "",
      responsePath: "",
      langMap: "",
    }
  }
  // 预设里 langMap 用 | 分隔（避开多行输入），落到 config 时转成换行存储。
  const langMap = String(preset.config.langMap ?? "").replace(/\|/g, "\n")
  return {
    httpMethod: preset.config.httpMethod ?? "GET",
    requestUrl: preset.config.requestUrl ?? "",
    requestHeaders: preset.config.requestHeaders ?? "",
    requestBody: preset.config.requestBody ?? "",
    responsePath: preset.config.responsePath ?? "",
    langMap,
  }
}

export function addCustomApiEngine(
  settings: TranslatorSettings,
  preset?: CustomApiPreset
): TranslatorSettings {
  return normalizeTranslatorSettings({
    ...settings,
    engines: [
      ...settings.engines,
      {
        id: `custom_api_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        kind: "custom_api",
        label: preset ? preset.label : "自定义接口",
        systemImage: "text.badge.plus",
        enabled: false,
        isBuiltIn: false,
        config: buildCustomApiConfig(preset),
      },
    ],
  })
}
