// 键盘侧的跨脚本共享模型池读取层。
// 与 translate/utils/model_pool.ts 使用完全相同的 shared Storage 键契约，
// 但键盘作为独立脚本不 import 翻译器代码，这里仅实现"读池 + 写激活/最近"所需的子集。
// 注意：翻译器是 ai_model_pool_v1 的唯一结构写入者；键盘只读渲染，点选时写 ai_active_model_v1 与 ai_model_recents_v1。

export const POOL_KEY = "ai_model_pool_v1";
export const ACTIVE_KEY = "ai_active_model_v1";
export const RECENTS_KEY = "ai_model_recents_v1";
export const POOL_VERSION = 1;
const RECENTS_LIMIT = 8;

export type AiModelKind = "ai_api" | "assistant";

export type AiModelPoolEntry = {
  id: string;
  engineId: string;
  kind: AiModelKind;
  label: string;
  providerLabel?: string;
  keywords?: string;
  compatibilityMode?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  assistantProviderId?: string;
  assistantCustomProvider?: string;
  assistantModelId?: string;
  lastUsedAt?: number;
  updatedAt: number;
};

function storage(): any {
  return (globalThis as any).Storage;
}

function safeGet(key: string): any {
  const st = storage();
  try {
    return st?.get?.(key, { shared: true });
  } catch {
    return undefined;
  }
}

function safeSet(key: string, value: unknown) {
  const st = storage();
  try {
    st?.set?.(key, value, { shared: true });
  } catch {}
}

function now(): number {
  return Date.now();
}

function normalizeEntry(item: any): AiModelPoolEntry | null {
  if (!item || typeof item !== "object" || !item.id) return null;
  return {
    id: String(item.id),
    engineId: String(item.engineId ?? ""),
    kind: item.kind === "assistant" ? "assistant" : "ai_api",
    label: String(item.label ?? item.id),
    providerLabel: item.providerLabel ? String(item.providerLabel) : undefined,
    keywords: item.keywords ? String(item.keywords) : undefined,
    compatibilityMode: item.compatibilityMode
      ? String(item.compatibilityMode)
      : undefined,
    baseUrl: item.baseUrl ? String(item.baseUrl) : undefined,
    apiKey: item.apiKey ? String(item.apiKey) : undefined,
    model: item.model ? String(item.model) : undefined,
    assistantProviderId: item.assistantProviderId
      ? String(item.assistantProviderId)
      : undefined,
    assistantCustomProvider: item.assistantCustomProvider
      ? String(item.assistantCustomProvider)
      : undefined,
    assistantModelId: item.assistantModelId
      ? String(item.assistantModelId)
      : undefined,
    lastUsedAt: typeof item.lastUsedAt === "number" ? item.lastUsedAt : undefined,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : now(),
  };
}

export function loadPool(): AiModelPoolEntry[] {
  const raw = safeGet(POOL_KEY);
  const models = raw && typeof raw === "object" && Array.isArray(raw.models)
    ? raw.models
    : [];
  const result: AiModelPoolEntry[] = [];
  const seen = new Set<string>();
  for (const item of models) {
    const entry = normalizeEntry(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
  }
  return result;
}

function savePool(models: AiModelPoolEntry[]) {
  safeSet(POOL_KEY, { version: POOL_VERSION, models });
}

export function getActiveModel(): AiModelPoolEntry | null {
  return normalizeEntry(safeGet(ACTIVE_KEY));
}

export function getActiveModelId(): string {
  return getActiveModel()?.id ?? "";
}

export function setActiveModel(entry: AiModelPoolEntry | null) {
  if (!entry) {
    const st = storage();
    try {
      st?.remove?.(ACTIVE_KEY, { shared: true });
    } catch {}
    return;
  }
  safeSet(ACTIVE_KEY, entry);
}

export function getRecents(): string[] {
  const raw = safeGet(RECENTS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item)).filter(Boolean);
}

function saveRecents(ids: string[]) {
  safeSet(RECENTS_KEY, ids.slice(0, RECENTS_LIMIT));
}

export function markUsed(id: string) {
  if (!id) return;
  const recents = getRecents().filter((item) => item !== id);
  recents.unshift(id);
  saveRecents(recents);

  const models = loadPool();
  const target = models.find((item) => item.id === id);
  if (target) {
    target.lastUsedAt = now();
    savePool(models);
  }
}

// 键盘内可用的条目：
//  - assistant：由 App 管理认证，无需 baseUrl/apiKey，直接走 Assistant.requestStreaming。
//  - ai_api：需同时具备 baseUrl+apiKey+model，键盘内直接 fetch。
export function isModelUsableInKeyboard(entry: AiModelPoolEntry): boolean {
  if (entry.kind === "assistant") {
    // Assistant 由 App 管理认证；全局可用性在调用时进一步把关。
    return typeof (globalThis as any).Assistant !== "undefined";
  }
  if (entry.kind !== "ai_api") return false;
  return !!String(entry.baseUrl ?? "").trim() &&
    !!String(entry.apiKey ?? "").trim() &&
    !!String(entry.model ?? "").trim();
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
    .toLowerCase();
}

export function filterEntries(
  entries: AiModelPoolEntry[],
  query: string,
): AiModelPoolEntry[] {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((entry) => searchableText(entry).includes(q));
}

// 供键盘浮层：最近使用/lastUsedAt 置顶，其余按名称排序。
export function listSortedForPicker(): {
  entries: AiModelPoolEntry[];
  activeId: string;
} {
  const models = loadPool();
  const activeId = getActiveModelId();
  const recents = getRecents();
  const byId = new Map(models.map((item) => [item.id, item]));

  const ordered: AiModelPoolEntry[] = [];
  const used = new Set<string>();
  for (const id of recents) {
    const entry = byId.get(id);
    if (entry && !used.has(entry.id)) {
      ordered.push(entry);
      used.add(entry.id);
    }
  }
  const rest = models
    .filter((item) => !used.has(item.id))
    .sort((a, b) => {
      const la = a.lastUsedAt ?? 0;
      const lb = b.lastUsedAt ?? 0;
      if (la !== lb) return lb - la;
      return a.label.localeCompare(b.label);
    });

  return { entries: [...ordered, ...rest], activeId };
}

export function modelEntryLabel(entry: AiModelPoolEntry | null): string {
  if (!entry) return "";
  return entry.label || entry.model || entry.assistantModelId || entry.id;
}
