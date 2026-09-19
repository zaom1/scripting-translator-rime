import {
  Button,
  Group,
  HStack,
  Image,
  List,
  Navigation,
  NavigationStack,
  Picker,
  Section,
  Spacer,
  Text,
  TextField,
  VStack,
  useEffect,
  useMemo,
  useState,
} from "scripting"
import type { AiApiCompatibilityMode } from "../types"
import {
  addManualModel,
  filterEntries,
  groupEntriesByProvider,
  listSortedForPicker,
  modelEntryLabel,
  refreshPoolFromSettings,
  removeModel,
  setActiveModel,
  markUsed,
  type AiModelPoolEntry,
} from "../utils/model_pool"
import { loadTranslatorSettings } from "../utils/translator_settings"

function subtitleOf(entry: AiModelPoolEntry): string {
  if (entry.kind === "assistant") {
    const provider = entry.assistantProviderId === "custom"
      ? (entry.assistantCustomProvider || "custom")
      : (entry.assistantProviderId || "openai")
    return `Assistant · ${provider}${entry.assistantModelId ? ` · ${entry.assistantModelId}` : ""}`
  }
  const base = entry.baseUrl ? entry.baseUrl.replace(/^https?:\/\//, "") : "AI 接口"
  return `${base}${entry.model ? ` · ${entry.model}` : ""}`
}

function ModelRow(props: {
  entry: AiModelPoolEntry
  isActive: boolean
  canDelete: boolean
  onPick: () => void
  onDelete: () => void
}) {
  const { entry, isActive, canDelete } = props
  return (
    <HStack spacing={10}>
      {isActive ? (
        <Image systemName="checkmark.circle.fill" foregroundStyle="accentColor" font="body" />
      ) : (
        <Image systemName="circle" foregroundStyle="tertiaryLabel" font="body" />
      )}
      <VStack spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
        <Text
          font="body"
          fontWeight={isActive ? "semibold" : "regular"}
          foregroundStyle={isActive ? "accentColor" : "primary"}
          lineLimit={1}
          truncationMode="tail"
        >
          {entry.model || entry.label}
        </Text>
        <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1} truncationMode="tail">
          {subtitleOf(entry)}
        </Text>
      </VStack>
      <Spacer />
      <Button action={props.onPick}>
        <Image systemName="arrow.right.circle" foregroundStyle="accentColor" />
      </Button>
    </HStack>
  )
}

// 键盘/翻译器共用的带搜索过滤模型选择面板（SwiftUI 侧，供翻译器 present 复用）。
export function ModelPickerView(props: {
  allowsEditPool?: boolean
  onSelect?: (entry: AiModelPoolEntry) => void
}) {
  const dismiss = Navigation.useDismiss()
  const [query, setQuery] = useState("")
  const [refreshKey, setRefreshKey] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState("")
  const allowsEditPool = props.allowsEditPool ?? true

  const { entries, activeId } = useMemo(() => {
    void refreshKey
    return listSortedForPicker()
  }, [refreshKey])

  const filtered = useMemo(() => filterEntries(entries, query), [entries, query])
  const grouping = useMemo(
    () => groupEntriesByProvider(filtered),
    [filtered],
  )

  async function refreshPool() {
    setRefreshing(true)
    setRefreshMsg("")
    try {
      await refreshPoolFromSettings(loadTranslatorSettings())
    } catch {
      setRefreshMsg("刷新模型列表失败，请检查 AI 接口配置。")
    } finally {
      setRefreshing(false)
      setRefreshKey((current) => current + 1)
    }
  }

  useEffect(() => {
    void refreshPool()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function pick(entry: AiModelPoolEntry) {
    markUsed(entry.id)
    setActiveModel(entry)
    if (props.onSelect) {
      props.onSelect(entry)
      return
    }
    dismiss(entry)
  }

  async function addModel() {
    const draft = await presentAddModelForm()
    if (!draft) return
    addManualModel(draft)
    setRefreshKey((current) => current + 1)
  }

  function remove(entry: AiModelPoolEntry) {
    removeModel(entry.id)
    setRefreshKey((current) => current + 1)
  }

  const hasResults = filtered.length > 0

  return (
    <NavigationStack>
      <List
        navigationTitle="选择模型"
        navigationBarTitleDisplayMode="inline"
        listStyle="insetGroup"
        scrollDismissesKeyboard="interactively"
        toolbar={{
          topBarLeading: (
            <Button action={() => dismiss(null)}>
              <Image systemName="xmark" fontWeight="semibold" foregroundStyle="red" />
            </Button>
          ),
        }}
      >
        <Section>
          <TextField
            title=""
            value={query}
            onChanged={setQuery}
            prompt="搜索供应商 / 模型 / 拼音 / ID"
          />
          <Button
            title={refreshing ? "刷新中…" : "刷新模型列表"}
            systemImage="arrow.clockwise"
            action={() => { void refreshPool() }}
          />
          {refreshMsg ? (
            <Text font="caption" foregroundStyle="secondaryLabel">{refreshMsg}</Text>
          ) : null}
        </Section>

        {hasResults ? (
          grouping.map((group) => (
            <Section key={group.provider} header={<Text>{group.provider}（{group.entries.length}）</Text>}>
              {group.entries.map((entry) => (
                <Group key={entry.id}>
                  <ModelRow
                    entry={entry}
                    isActive={entry.id === activeId}
                    canDelete={allowsEditPool && !entry.engineId}
                    onPick={() => pick(entry)}
                    onDelete={() => remove(entry)}
                  />
                  {allowsEditPool && !entry.engineId ? (
                    <Button
                      title="删除"
                      systemImage="trash"
                      buttonStyle="bordered"
                      action={() => remove(entry)}
                    />
                  ) : null}
                </Group>
              ))}
            </Section>
          ))
        ) : (
          <Section header={<Text>{refreshing ? "正在获取模型…" : "无匹配模型"}</Text>}>
            <Text foregroundStyle="secondaryLabel">
              {refreshing
                ? "正在从各 AI 接口拉取模型列表…"
                : (entries.length === 0
                    ? "模型池为空。请在“设置”中添加 AI 接口（填写 Base URL 与 API Key），再点“刷新模型列表”。"
                    : "没有匹配的模型，试试其它关键词。")}
            </Text>
          </Section>
        )}

        {allowsEditPool ? (
          <Section>
            <Button
              title="新增模型"
              systemImage="plus.circle"
              action={addModel}
            />
          </Section>
        ) : null}
      </List>
    </NavigationStack>
  )
}

export async function presentModelPicker(opts?: {
  allowsEditPool?: boolean
}): Promise<AiModelPoolEntry | null> {
  const result = await Navigation.present({
    element: <ModelPickerView allowsEditPool={opts?.allowsEditPool ?? true} />,
    modalPresentationStyle: "formSheet",
  })
  if (result && typeof result === "object" && (result as any).id) {
    return result as AiModelPoolEntry
  }
  return null
}

function AddModelView() {
  const dismiss = Navigation.useDismiss()
  const [label, setLabel] = useState("")
  const [model, setModel] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [keywords, setKeywords] = useState("")
  const [compatibilityMode, setCompatibilityMode] = useState<AiApiCompatibilityMode>("custom")

  function submit() {
    const trimmedModel = model.trim()
    if (!trimmedModel) return
    dismiss({
      kind: "ai_api",
      label: label.trim() || trimmedModel,
      model: trimmedModel,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      keywords: keywords.trim() || undefined,
      compatibilityMode,
    })
  }

  return (
    <NavigationStack>
      <List
        navigationTitle="新增模型"
        navigationBarTitleDisplayMode="inline"
        listStyle="insetGroup"
        toolbar={{
          topBarLeading: (
            <Button action={() => dismiss(null)}>
              <Image systemName="xmark" fontWeight="semibold" foregroundStyle="red" />
            </Button>
          ),
          topBarTrailing: (
            <Button action={submit}>
              <Text fontWeight="semibold" foregroundStyle="accentColor">添加</Text>
            </Button>
          ),
        }}
      >
        <Section header={<Text>基本信息</Text>}>
          <TextField title="显示名" value={label} onChanged={setLabel} prompt="用于检索展示的名称" />
          <TextField title="模型 ID" value={model} onChanged={setModel} prompt="如 gpt-4o-mini" />
          <TextField
            title="检索别名"
            value={keywords}
            onChanged={setKeywords}
            prompt="拼音/别名，提升搜索命中（可选）"
          />
        </Section>
        <Section header={<Text>接口</Text>}>
          <Picker
            title="兼容模式"
            value={compatibilityMode}
            onChanged={(value: AiApiCompatibilityMode) => setCompatibilityMode(value)}
          >
            <Text tag="custom" >自定义 / New API</Text>
            <Text tag="openai">OpenAI</Text>
            <Text tag="gemini">Gemini</Text>
            <Text tag="siliconflow">SiliconFlow</Text>
            <Text tag="qwen">通义千问</Text>
          </Picker>
          <TextField title="Base URL" value={baseUrl} onChanged={setBaseUrl} prompt="https://api.example.com" />
          <TextField title="API Key" value={apiKey} onChanged={setApiKey} prompt="sk-..." />
        </Section>
      </List>
    </NavigationStack>
  )
}

async function presentAddModelForm(): Promise<Partial<AiModelPoolEntry> | null> {
  const result = await Navigation.present({
    element: <AddModelView />,
    modalPresentationStyle: "formSheet",
  })
  if (result && typeof result === "object") {
    return result as Partial<AiModelPoolEntry>
  }
  return null
}

export { modelEntryLabel }
