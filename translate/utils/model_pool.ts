import type {
  AiApiCompatibilityMode,
  TranslationEngineConfig,
  TranslationProgressCallbacks,
  TranslationRequest,
  TranslationResult,
  TranslatorEngineEntry,
  TranslatorSettings,
} from "../types"
import {
  translateWithExternalEngine,
} from "./external_translation_engines"
import {
  createAssistantTranslationEngine,
} from "./assistant_translation_engine"
import { fetchAiApiModels } from "./ai_api_models"

// 跨脚本共享存储契约（必须始终 {shared:true}，独立于私有的 translator_settings_v2）。
// 翻译器是 ai_model_pool_v1 的唯一"结构写入者"；键盘只读池渲染，点选时写激活/最近键。
export const POOL_KEY = "ai_model_pool_v1"
export const ACTIVE_KEY = "ai_active_model_v1"
export const RECENTS_KEY = "ai_model_recents_v1"
export const POOL_VERSION = 1
const RECENTS_LIMIT = 8

export type AiModelKind = "ai_api" | "assistant"

export type AiModelPoolEntry = {
  id: string
  engineId: string
  kind: AiModelKind
  label: string
  providerLabel?: string
  keywords?: string
  // ai_api 快照
  compatibilityMode?: AiApiCompatibilityMode
  baseUrl?: string
  apiKey?: string
  model?: string
  // assistant 快照
  assistantProviderId?: TranslationEngineConfig["assistantProviderId"]
  assistantCustomProvider?: string
  assistantModelId?: string
  lastUsedAt?: number
  updatedAt: number
}

export type AiModelPool = {
  version: number
  models: AiModelPoolEntry[]
}

function storage() {
  return (globalThis as any).Storage
}

function safeGet(key: string): any {
  const st = storage()
  try {
    return st?.get?.(key, { shared: true })
  } catch {
    return undefined
  }
}

function safeSet(key: string, value: unknown) {
  const st = storage()
  try {
    st?.set?.(key, value, { shared: true })
  } catch {}
}

function now() {
  return Date.now()
}

function buildEntryId(kind: AiModelKind, engineId: string, model: string) {
  return `${kind}::${engineId}::${model || "default"}`
}

function normalizePool(raw: any): AiModelPool {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.models)) {
    return { version: POOL_VERSION, models: [] }
  }
  const models: AiModelPoolEntry[] = []
  const seen = new Set<string>()
  for (const item of raw.models) {
    if (!item || typeof item !== "object" || !item.id || seen.has(String(item.id))) continue
    seen.add(String(item.id))
    models.push({
      id: String(item.id),
      engineId: String(item.engineId ?? ""),
      kind: item.kind === "assistant" ? "assistant" : "ai_api",
      label: String(item.label ?? item.id),
      providerLabel: item.providerLabel ? String(item.providerLabel) : undefined,
      keywords: item.keywords ? String(item.keywords) : undefined,
      compatibilityMode: item.compatibilityMode,
      baseUrl: item.baseUrl ? String(item.baseUrl) : undefined,
      apiKey: item.apiKey ? String(item.apiKey) : undefined,
      model: item.model ? String(item.model) : undefined,
      assistantProviderId: item.assistantProviderId,
      assistantCustomProvider: item.assistantCustomProvider
        ? String(item.assistantCustomProvider)
        : undefined,
      assistantModelId: item.assistantModelId ? String(item.assistantModelId) : undefined,
      lastUsedAt: typeof item.lastUsedAt === "number" ? item.lastUsedAt : undefined,
      updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : now(),
    })
  }
  return { version: POOL_VERSION, models }
}

export function loadPool(): AiModelPool {
  return normalizePool(safeGet(POOL_KEY))
}

export function savePool(pool: AiModelPool) {
  safeSet(POOL_KEY, { version: POOL_VERSION, models: pool.models })
}

export function getActiveModel(): AiModelPoolEntry | null {
  const raw = safeGet(ACTIVE_KEY)
  if (!raw || typeof raw !== "object" || !raw.id) return null
  return normalizePool({ version: POOL_VERSION, models: [raw] }).models[0] ?? null
}

export function getActiveModelId(): string {
  return getActiveModel()?.id ?? ""
}

export function setActiveModel(entry: AiModelPoolEntry | null) {
  if (!entry) {
    const st = storage()
    try {
      st?.remove?.(ACTIVE_KEY, { shared: true })
    } catch {}
    return
  }
  safeSet(ACTIVE_KEY, entry)
}

export function getRecents(): string[] {
  const raw = safeGet(RECENTS_KEY)
  if (!Array.isArray(raw)) return []
  return raw.map((item) => String(item)).filter(Boolean)
}

function saveRecents(ids: string[]) {
  safeSet(RECENTS_KEY, ids.slice(0, RECENTS_LIMIT))
}

export function markUsed(id: string) {
  if (!id) return
  const recents = getRecents().filter((item) => item !== id)
  recents.unshift(id)
  saveRecents(recents)

  // 同步更新池内该条目的 lastUsedAt，便于跨脚本排序一致。
  const pool = loadPool()
  const target = pool.models.find((item) => item.id === id)
  if (target) {
    target.lastUsedAt = now()
    savePool(pool)
  }
}

// 把翻译器设置里每个「AI 接口」引擎视为一个供应商，实时调用其 /v1/models
// 枚举出该供应商的全部模型，展开成「供应商 × 模型」的多条池条目。
// 保留手动新增条目与既有条目的 lastUsedAt；裁剪掉已删除/过期的派生条目。
export async function refreshPoolFromSettings(
  settings: TranslatorSettings,
): Promise<AiModelPool> {
  const existing = loadPool()
  const existingById = new Map(existing.models.map((item) => [item.id, item]))
  const next: AiModelPoolEntry[] = []

  for (const engine of settings.engines) {
    if (engine.kind !== "ai_api") continue
    const config = engine.config ?? {}
    const apiKey = String(config.apiKey ?? "").trim()
    const mode = (config.compatibilityMode ?? "custom") as AiApiCompatibilityMode
    const baseUrl = String(config.baseUrl ?? "").trim()
    if (!apiKey) continue
    if (mode === "custom" && !baseUrl) continue

    let modelIds: string[] = []
    try {
      const result = await fetchAiApiModels({
        compatibilityMode: mode,
        baseUrl,
        apiKey,
      })
      modelIds = Array.isArray(result.modelIds) ? result.modelIds : []
    } catch {}

    const fallbackModel = String(config.model ?? "").trim()
    const models = modelIds.length
      ? modelIds
      : (fallbackModel ? [fallbackModel] : [])
    const providerLabel = engine.label || "AI 接口"

    for (const model of models) {
      const id = buildEntryId("ai_api", engine.id, model)
      const prev = existingById.get(id)
      next.push({
        id,
        engineId: engine.id,
        kind: "ai_api",
        label: `${providerLabel} · ${model}`,
        providerLabel,
        keywords: prev?.keywords,
        compatibilityMode: mode,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model,
        lastUsedAt: prev?.lastUsedAt,
        updatedAt: now(),
      })
    }
  }

  // 扫描 assistant 引擎，生成 assistant 类型池条目（桥接 App 原生 Assistant 配置）。
  for (const engine of settings.engines) {
    if (engine.kind !== "assistant") continue
    // Assistant 全局可用性检查
    const assistantGlobal = (globalThis as any).Assistant
    if (typeof assistantGlobal === "undefined" || !assistantGlobal) continue
    try { if (!assistantGlobal.isAvailable) continue } catch { continue }

    const config = engine.config ?? {}
    const modelId = String(config.assistantModelId ?? "").trim()
    const providerId = config.assistantProviderId ?? "openai"
    const customProvider = String(config.assistantCustomProvider ?? "").trim()

    // 如果 assistantModelId 为空，创建一条 "默认" 条目（Assistant 会使用 App 默认模型）
    const effectiveModel = modelId || "(App 默认)"
    const id = buildEntryId("assistant", engine.id, effectiveModel)
    const prev = existingById.get(id)
    const providerLabel = engine.label || "App Assistant"

    next.push({
      id,
      engineId: engine.id,
      kind: "assistant",
      label: `${providerLabel} · ${effectiveModel}`,
      providerLabel,
      assistantProviderId: providerId as TranslationEngineConfig["assistantProviderId"],
      assistantCustomProvider: customProvider || undefined,
      assistantModelId: modelId || undefined,
      lastUsedAt: prev?.lastUsedAt,
      updatedAt: now(),
    })
  }

  // 保留手动新增（engineId 为空的非派生条目），它们不受枚举裁剪影响。
  for (const item of existing.models) {
    if (!item.engineId && !next.some((entry) => entry.id === item.id)) {
      next.push(item)
    }
  }

  const pool: AiModelPool = { version: POOL_VERSION, models: next }
  savePool(pool)

  // 若激活模型已不在池中，清理之。
  const active = getActiveModel()
  if (active && !next.some((item) => item.id === active.id)) {
    setActiveModel(null)
  }

  return pool
}

export function addManualModel(input: Partial<AiModelPoolEntry>): AiModelPoolEntry {
  const model = String(input.model ?? "").trim()
  const kind: AiModelKind = input.kind === "assistant" ? "assistant" : "ai_api"
  const entry: AiModelPoolEntry = {
    id: input.id?.trim() || buildEntryId(kind, `manual_${now().toString(36)}`, model),
    engineId: "",
    kind,
    label: String(input.label ?? "").trim() || model || "自定义模型",
    providerLabel: String(input.providerLabel ?? input.label ?? "").trim() || "自定义",
    keywords: input.keywords ? String(input.keywords) : undefined,
    compatibilityMode: input.compatibilityMode ?? "custom",
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    model,
    assistantProviderId: input.assistantProviderId,
    assistantCustomProvider: input.assistantCustomProvider,
    assistantModelId: input.assistantModelId,
    lastUsedAt: input.lastUsedAt,
    updatedAt: now(),
  }
  const pool = loadPool()
  pool.models = pool.models.filter((item) => item.id !== entry.id)
  pool.models.unshift(entry)
  savePool(pool)
  return entry
}

export function removeModel(id: string) {
  if (!id) return
  const pool = loadPool()
  pool.models = pool.models.filter((item) => item.id !== id)
  savePool(pool)
  if (getActiveModelId() === id) setActiveModel(null)
  saveRecents(getRecents().filter((item) => item !== id))
}

export function searchableText(entry: AiModelPoolEntry): string {
  return [
    entry.label,
    entry.providerLabel,
    entry.id,
    entry.model,
    entry.assistantModelId,
    entry.assistantProviderId,
    entry.assistantCustomProvider,
    entry.keywords,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function compareEntry(a: AiModelPoolEntry, b: AiModelPoolEntry) {
  return a.label.localeCompare(b.label)
}

// 供选择器：最近使用/lastUsedAt 置顶，其余按名称排序。
export function listSortedForPicker(): { entries: AiModelPoolEntry[]; activeId: string } {
  const pool = loadPool()
  const activeId = getActiveModelId()
  const recents = getRecents()
  const byId = new Map(pool.models.map((item) => [item.id, item]))

  const ordered: AiModelPoolEntry[] = []
  const used = new Set<string>()

  for (const id of recents) {
    const entry = byId.get(id)
    if (entry && !used.has(entry.id)) {
      ordered.push(entry)
      used.add(entry.id)
    }
  }

  const rest = pool.models
    .filter((item) => !used.has(item.id))
    .sort((a, b) => {
      const la = a.lastUsedAt ?? 0
      const lb = b.lastUsedAt ?? 0
      if (la !== lb) return lb - la
      return compareEntry(a, b)
    })

  return { entries: [...ordered, ...rest], activeId }
}

// 供 AI 接口(ai_api)卡片：列出该供应商（engineId）在池内展开出的全部模型，
// 用于「本供应商范围内」的模型切换（一个接口=一个供应商）。
export function listProviderModels(engineId: string): AiModelPoolEntry[] {
  if (!engineId) return []
  return loadPool().models.filter((item) => item.kind === "ai_api" && item.engineId === engineId)
}

export function findPoolEntry(id: string): AiModelPoolEntry | null {
  if (!id) return null
  return loadPool().models.find((item) => item.id === id) ?? null
}

export function filterEntries(entries: AiModelPoolEntry[], query: string): AiModelPoolEntry[] {
  const q = String(query ?? "").trim().toLowerCase()
  if (!q) return entries
  return entries.filter((entry) => searchableText(entry).includes(q))
}

// 按供应商（providerLabel）分组，供选择器分区展示。保持传入顺序（最近置顶）。
export function groupEntriesByProvider(
  entries: AiModelPoolEntry[],
): Array<{ provider: string; entries: AiModelPoolEntry[] }> {
  const groups: Array<{ provider: string; entries: AiModelPoolEntry[] }> = []
  const index = new Map<string, number>()
  for (const entry of entries) {
    const provider = entry.providerLabel || entry.label || "AI 接口"
    const at = index.get(provider)
    if (at === undefined) {
      index.set(provider, groups.length)
      groups.push({ provider, entries: [entry] })
    } else {
      groups[at].entries.push(entry)
    }
  }
  return groups
}

// 键盘可用性：仅 ai_api（含 baseUrl+apiKey+model）条目可在键盘内直接 fetch。
export function isModelUsableInKeyboard(entry: AiModelPoolEntry): boolean {
  if (entry.kind !== "ai_api") return false
  return !!String(entry.baseUrl ?? "").trim() &&
    !!String(entry.apiKey ?? "").trim() &&
    !!String(entry.model ?? "").trim()
}

// 单模型翻译派发：复用现有引擎实现，避免重写流式/分块逻辑。
export async function translateWithModelEntry(
  entry: AiModelPoolEntry,
  request: TranslationRequest,
  callbacks?: TranslationProgressCallbacks
): Promise<TranslationResult> {
  if (entry.kind === "assistant") {
    const config: TranslationEngineConfig = {
      assistantProviderId: entry.assistantProviderId ?? "openai",
      assistantCustomProvider: entry.assistantCustomProvider,
      assistantModelId: entry.assistantModelId,
    }
    return await createAssistantTranslationEngine(config).translate(request, callbacks)
  }

  const syntheticEngine: TranslatorEngineEntry = {
    id: entry.id,
    kind: "ai_api",
    label: entry.label,
    systemImage: "sparkles",
    enabled: true,
    isBuiltIn: false,
    config: {
      compatibilityMode: entry.compatibilityMode ?? "custom",
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey,
      model: entry.model,
    },
  }
  return await translateWithExternalEngine(syntheticEngine, request, callbacks)
}

export function modelEntryLabel(entry: AiModelPoolEntry | null): string {
  if (!entry) return ""
  return entry.label || entry.model || entry.assistantModelId || entry.id
}
