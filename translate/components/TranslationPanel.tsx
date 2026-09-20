import {
  Button,
  Group,
  HStack,
  Image,
  List,
  Menu,
  Picker,
  ProgressView,
  Section,
  Spacer,
  Text,
  TextField,
  VStack,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "scripting"
import type { PresentationDetent } from "scripting"

import { AUTO_LANGUAGE, LANGUAGE_OPTIONS } from "../constants"
import type {
  EngineTranslationState,
  LanguageOption,
  TranslatorEngineEntry,
} from "../types"
import {
  createAssistantTranslationEngine,
  isAssistantTranslationAvailable,
} from "../utils/assistant_translation_engine"
import {
  createTranslationEngine,
  detectSourceLanguageCode,
  isLocalTranslationAvailable,
} from "../utils/translation_engine"
import {
  isExternalEngineConfigured,
  translateWithExternalEngine,
} from "../utils/external_translation_engines"
import {
  createSystemTranslationEngine,
  isSystemTranslationAvailable,
} from "../utils/system_translation_engine"
import { finishTranslation } from "../utils/translation_session"
import {
  getExecutableEngines,
  loadTranslatorSettings,
  saveTranslatorSettings,
  updateEngineConfig,
} from "../utils/translator_settings"
import {
  findPoolEntry,
  getActiveModel,
  listProviderModels,
  listSortedForPicker,
  markUsed,
  modelEntryLabel,
  setActiveModel,
  translateWithModelEntry,
  type AiModelPoolEntry,
} from "../utils/model_pool"

type TranslationPanelProps = {
  inputText?: string | null
  allowsReplacement: boolean
  editableSource?: boolean
  embedded?: boolean
  navigationTitle?: string
  showDismissButton?: boolean
  showsScrollContentBackground?: boolean
  settingsRefreshKey?: number
  singleModelMode?: boolean
  requireModelSelection?: boolean
}

function summarizeText(text: string, maxLength = 48) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim()
  if (!normalized) return ""
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized
}

function logTranslationEvent(message: string, payload?: Record<string, unknown>) {
  if (payload) {
    console.log(`[Translator] ${message}`, payload)
    return
  }
  console.log(`[Translator] ${message}`)
}

function assistantLogOptions(engine: { kind?: string; config?: any }) {
  if (engine.kind !== "assistant") return {}

  const providerId = String(engine.config?.assistantProviderId ?? "openai").trim() || "openai"
  const customProvider = String(engine.config?.assistantCustomProvider ?? "").trim()
  const modelId = String(engine.config?.assistantModelId ?? "").trim()

  return {
    provider: providerId === "custom" ? `{ custom: "${customProvider}" }` : providerId,
    modelId: modelId || "(default)",
  }
}

function withHaptic(action: () => void | Promise<void>) {
  return () => {
    try {
      HapticFeedback.lightImpact()
    } catch {}
    void action()
  }
}

function pickerLabel(option: LanguageOption) {
  if (option.code === AUTO_LANGUAGE.code) {
    return "自动检测-Auto"
  }

  return `${option.label}-${option.promptName}`
}

function LanguageMenu(props: {
  title: string
  value: string
  selectedLabel: string
  onChanged: (value: string) => void
  options: LanguageOption[]
  alignment?: "leading" | "trailing"
}) {
  const align = props.alignment ?? "leading"
  return (
    <Menu
      label={
        <HStack spacing={4}>
          <Text
            font="subheadline"
            foregroundStyle="secondaryLabel"
            lineLimit={1}
            truncationMode="tail"
            allowsTightening
            frame={{ maxWidth: 150, alignment: align as any }}
            multilineTextAlignment={align}
          >
            {props.selectedLabel}
          </Text>
          <Image
            systemName="chevron.down"
            font="caption2"
            foregroundStyle="tertiaryLabel"
          />
        </HStack>
      }
    >
      <Picker
        title={props.title}
        value={props.value}
        onChanged={props.onChanged}
      >
        {props.options.map((option) => (
          <Text key={option.code} tag={option.code}>
            {pickerLabel(option)}
          </Text>
        ))}
      </Picker>
    </Menu>
  )
}

function CopyableTextRow(props: {
  text: string
  emptyText?: string
  foregroundStyle?: any
  lineLimit?: number
  extraMenuButtons?: Array<{
    title: string
    systemImage: string
    action: () => void | Promise<void>
  }>
  canReplace?: boolean
  onTapWhenEmpty?: () => void | Promise<void>
  onRetranslate?: () => void | Promise<void>
  onReplace?: () => void | Promise<void>
}) {
  const hasText = props.text.trim().length > 0
  const hasMenu = hasText || !!props.onRetranslate || (!!props.onReplace && !!props.canReplace) || !!props.extraMenuButtons?.length
  const copyAction = withHaptic(async () => {
    if (!hasText) return
    await Pasteboard.setString(props.text)
    try {
      HapticFeedback.notificationSuccess()
    } catch {}
  })
  const emptyTapAction = props.onTapWhenEmpty ? withHaptic(props.onTapWhenEmpty) : undefined

  return (
    <Text
      onTapGesture={hasText ? copyAction : emptyTapAction}
      contextMenu={hasMenu ? {
        menuItems: (
          <Group>
            {hasText ? (
              <Button
                title="复制"
                systemImage="doc.on.doc"
                action={withHaptic(async () => {
                  await Pasteboard.setString(props.text)
                })}
              />
            ) : null}
            {props.onRetranslate ? (
              <Button
                title="重译"
                systemImage="arrow.clockwise"
                action={withHaptic(props.onRetranslate)}
              />
            ) : null}
            {props.onReplace ? (
              <Button
                title="替换原文"
                systemImage="rectangle.and.pencil.and.ellipsis"
                disabled={!props.canReplace}
                action={withHaptic(props.onReplace)}
              />
            ) : null}
            {props.extraMenuButtons?.map((item) => (
              <Button
                key={`${item.title}-${item.systemImage}`}
                title={item.title}
                systemImage={item.systemImage}
                action={withHaptic(item.action)}
              />
            ))}
          </Group>
        ),
      } : undefined}
      frame={{ maxWidth: "infinity", alignment: "leading" as any }}
      contentShape={{
        kind: "interaction",
        shape: "rect",
      }}
      multilineTextAlignment="leading"
      selectionDisabled={false}
      foregroundStyle={props.foregroundStyle}
      lineLimit={props.lineLimit}
      truncationMode="tail"
    >
      {hasText ? props.text : (props.emptyText || "")}
    </Text>
  )
}

function shouldCollapseSourceText(text: string) {
  const normalized = String(text ?? "").trim()
  if (!normalized) return false

  const lines = normalized.split(/\r?\n/)
  if (lines.length > 2) return true
  if (lines.some((line) => line.trim().length > 56)) return true
  return normalized.length > 110
}

export function TranslationPanel(props: TranslationPanelProps) {
  const [settings, setSettings] = useState(() => loadTranslatorSettings())
  const [draftSourceText, setDraftSourceText] = useState(() => props.inputText ?? "")
  const sourceText = props.editableSource ? draftSourceText : (props.inputText ?? "")
  const hasInput = sourceText.trim().length > 0
  const [sourceLanguageCode, setSourceLanguageCode] = useState(() => settings.defaultSourceLanguageCode)
  const [targetLanguageCode, setTargetLanguageCode] = useState(() => settings.defaultTargetLanguageCode)
  const [systemTranslationHost] = useState(() => new Translation())
  const [errorText, setErrorText] = useState("")
  const [engineResults, setEngineResults] = useState<EngineTranslationState[]>([])
  const [isSourceExpanded, setIsSourceExpanded] = useState(false)
  const [selectedModel, setSelectedModel] = useState<AiModelPoolEntry | null>(() =>
    props.singleModelMode ? getActiveModel() : null
  )
  const didInitModelRef = useRef(false)
  const requestIdRef = useRef(0)
  const targetTouchedRef = useRef(false)
  const executableEngines = getExecutableEngines(settings)
  const assistantConfig = settings.engines.find((engine) => engine.kind === "assistant")?.config
  const [appleEngine] = useState(() => createTranslationEngine())
  const [systemEngine] = useState(() => createSystemTranslationEngine(systemTranslationHost))

  // 「AI 翻译」卡（方案 A，整池任选）：选择只存本引擎 config + 内存 ref，
  // 绝不写全局激活模型/recents，避免把键盘当前模型带跑（与键盘解耦）。
  const [aiTranslateSelectionId, setAiTranslateSelectionId] = useState<string>(() => {
    const saved = String(
      loadTranslatorSettings().engines.find((engine) => engine.kind === "ai_translate")?.config
        ?.selectedPoolEntryId ?? "",
    ).trim()
    if (saved && findPoolEntry(saved)) return saved
    return listSortedForPicker().entries[0]?.id ?? ""
  })
  const aiTranslateSelectionIdRef = useRef(aiTranslateSelectionId)
  // ai_api 卡的「本供应商模型」会话内覆盖：engineId -> model。
  const modelOverrideRef = useRef<Record<string, string>>({})
  const [modelOverrideTick, setModelOverrideTick] = useState(0)

  function currentAiTranslateEntry(): AiModelPoolEntry | null {
    const id = aiTranslateSelectionIdRef.current
    if (id) {
      const found = findPoolEntry(id)
      if (found) return found
    }
    return listSortedForPicker().entries[0] ?? null
  }

  // ai_api 卡若命中会话内模型覆盖，则用合成 engine（同 baseUrl/apiKey，替换 model）。
  function resolveExternalEngine(engine: TranslatorEngineEntry): TranslatorEngineEntry {
    if (engine.kind === "ai_api") {
      const override = modelOverrideRef.current[engine.id]
      if (override && override !== engine.config?.model) {
        return { ...engine, config: { ...(engine.config ?? {}), model: override } }
      }
    }
    return engine
  }

  const visibleEngines = executableEngines.filter((engine) => {
    const available = engine.kind === "apple_intelligence"
      ? isLocalTranslationAvailable()
      : engine.kind === "assistant"
        ? isAssistantTranslationAvailable()
      : engine.kind === "ai_translate"
        ? listSortedForPicker().entries.length > 0
      : engine.kind === "system_translation"
        ? isSystemTranslationAvailable()
        : isExternalEngineConfigured(engine)

    return engine.enabled && available
  })

  function createLoadingStates(): EngineTranslationState[] {
    return visibleEngines.map((engine) => ({
      engineId: engine.id,
      engineName: engine.label,
      systemImage: engine.systemImage,
      translatedText: "",
      errorText: "",
      isTranslating: true,
    }))
  }

  function updatePartialEngineResult(engineId: string, translatedText: string) {
    setEngineResults((current) => current.map((item) => (
      item.engineId === engineId
        ? {
            ...item,
            translatedText,
            errorText: "",
            isTranslating: true,
          }
        : item
    )))
  }

  async function translateEngine(
    engine: typeof visibleEngines[number],
    options?: {
      onPartialText?: (text: string) => void | Promise<void>
    }
  ) {
    const request = {
      sourceText,
      sourceLanguageCode,
      targetLanguageCode,
    }

    if (engine.kind === "ai_translate") {
      const entry = currentAiTranslateEntry()
      if (!entry) {
        throw new Error("模型池为空，请先在设置里添加 AI 接口。")
      }
      const aiResult = await translateWithModelEntry(entry, request, options)
      return {
        engineId: engine.id,
        engineName: `AI 翻译 · ${entry.label}`,
        systemImage: engine.systemImage,
        translatedText: aiResult.translatedText,
        errorText: "",
        isTranslating: false,
      } satisfies EngineTranslationState
    }

    const result = engine.kind === "apple_intelligence"
      ? await appleEngine.translate(request, options)
      : engine.kind === "assistant"
        ? await createAssistantTranslationEngine(assistantConfig).translate(request, options)
        : engine.kind === "system_translation"
          ? await systemEngine.translate(request)
          : await translateWithExternalEngine(resolveExternalEngine(engine), request, options)

    return {
      engineId: engine.id,
      engineName: engine.label,
      systemImage: engine.systemImage,
      translatedText: result.translatedText,
      errorText: "",
      isTranslating: false,
    } satisfies EngineTranslationState
  }

  useEffect(() => {
    if (!props.editableSource) return
    setDraftSourceText(props.inputText ?? "")
  }, [props.editableSource, props.inputText])

  useEffect(() => {
    if (props.settingsRefreshKey == null) return

    const nextSettings = loadTranslatorSettings()
    setSettings(nextSettings)
    setSourceLanguageCode(nextSettings.defaultSourceLanguageCode)
    setTargetLanguageCode(nextSettings.defaultTargetLanguageCode)
    setErrorText("")
    setEngineResults([])
    targetTouchedRef.current = false
  }, [props.settingsRefreshKey])

  useEffect(() => {
    appleEngine.prewarm()
    return () => {
      appleEngine.dispose()
    }
  }, [appleEngine])

  const runTranslation = useEffectEvent(async () => {
    if (!hasInput) return

    if (props.singleModelMode) {
      let entry = selectedModel
      if (!entry) {
        // 不再使用 presentModelPicker（在系统翻译宿主中无法弹出）；
        // 优先用持久化的激活模型，否则取模型池第一个。
        entry = getActiveModel() ?? availableModels[0] ?? null
        if (!entry) {
          setErrorText("模型池为空，请先在设置里添加 AI 接口。")
          setEngineResults([])
          return
        }
        setSelectedModel(entry)
        markUsed(entry.id)
      }
      await translateWithSingleModel(entry)
      return
    }

    if (!visibleEngines.length) {
      logTranslationEvent("没有可执行的翻译引擎", {
        sourceLanguageCode,
        targetLanguageCode,
      })
      setEngineResults([])
      setErrorText("没有启用且可用的翻译引擎。")
      return
    }

    if (
      sourceLanguageCode !== AUTO_LANGUAGE.code &&
      sourceLanguageCode === targetLanguageCode
    ) {
      logTranslationEvent("源语言和目标语言相同，已拦截翻译", {
        sourceLanguageCode,
        targetLanguageCode,
      })
      setEngineResults(visibleEngines.map((engine) => ({
        engineId: engine.id,
        engineName: engine.label,
        systemImage: engine.systemImage,
        translatedText: "",
        errorText: "源语言和目标语言不能相同。",
        isTranslating: false,
      })))
      setErrorText("源语言和目标语言不能相同。")
      return
    }

    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    const startedAt = Date.now()
    setErrorText("")
    setEngineResults(createLoadingStates())
    logTranslationEvent("开始翻译", {
      requestId,
      sourceLength: sourceText.length,
      sourcePreview: summarizeText(sourceText),
      sourceLanguageCode,
      targetLanguageCode,
      engines: visibleEngines.map((engine) => ({
        engineName: engine.label,
        ...assistantLogOptions(engine),
      })),
    })

    try {
      // 这里逐条回填每个引擎的状态，不再在最后整体覆盖，避免未完成项丢掉自己的加载态。
      await Promise.allSettled(
        visibleEngines.map(async (engine) => {
          const engineStartedAt = Date.now()
          logTranslationEvent("引擎开始翻译", {
            requestId,
            engineId: engine.id,
            engineName: engine.label,
            ...assistantLogOptions(engine),
          })
          try {
            const result = await translateEngine(engine, {
              onPartialText: async (text: string) => {
                if (requestId !== requestIdRef.current) return
                updatePartialEngineResult(engine.id, text)
              },
            })
            if (requestId !== requestIdRef.current) return null
            logTranslationEvent("引擎翻译成功", {
              requestId,
              engineId: engine.id,
              engineName: engine.label,
              ...assistantLogOptions(engine),
              elapsedMs: Date.now() - engineStartedAt,
              translatedLength: result.translatedText.length,
              translatedPreview: summarizeText(result.translatedText),
            })

            setEngineResults((current) => current.map((item) => (
              item.engineId === engine.id ? result : item
            )))
            return result
          } catch (error) {
            if (requestId !== requestIdRef.current) return null
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[Translator] 引擎翻译失败`, {
              requestId,
              engineId: engine.id,
              engineName: engine.label,
              ...assistantLogOptions(engine),
              elapsedMs: Date.now() - engineStartedAt,
              error: message,
            })

            const failed = {
              engineId: engine.id,
              engineName: engine.label,
              systemImage: engine.systemImage,
              translatedText: "",
              errorText: message,
              isTranslating: false,
            } satisfies EngineTranslationState
            setEngineResults((current) => current.map((item) => (
              item.engineId === engine.id ? failed : item
            )))
            return failed
          }
        })
      )

      if (requestId !== requestIdRef.current) return
      logTranslationEvent("翻译完成", {
        requestId,
        elapsedMs: Date.now() - startedAt,
      })
      try {
        HapticFeedback.notificationSuccess()
      } catch {}
    } catch (error) {
      if (requestId !== requestIdRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[Translator] 翻译流程失败`, {
        requestId,
        elapsedMs: Date.now() - startedAt,
        error: message,
      })
      setErrorText(message)
      try {
        HapticFeedback.notificationError()
      } catch {}
    }
  })

  useEffect(() => {
    if (props.singleModelMode) return
    if (!hasInput) return
    void runTranslation()
  }, [hasInput, runTranslation, sourceLanguageCode, sourceText, targetLanguageCode])

  useEffect(() => {
    targetTouchedRef.current = false
    setIsSourceExpanded(false)
  }, [sourceText])

  useEffect(() => {
    if (!hasInput) return
    if (sourceLanguageCode !== AUTO_LANGUAGE.code) return
    if (targetTouchedRef.current) return
    if (settings.defaultTargetLanguageCode !== "zh-Hans") return

    let cancelled = false

    void (async () => {
      const detected = await detectSourceLanguageCode(sourceText)
      if (cancelled || !detected) return

      if ((detected === "zh-Hans" || detected === "zh-Hant") && targetLanguageCode !== "en") {
        logTranslationEvent("自动切换默认目标语言", {
          detectedSourceLanguageCode: detected,
          nextTargetLanguageCode: "en",
        })
        setTargetLanguageCode("en")
        return
      }

      if (detected === "en" && targetLanguageCode !== "zh-Hans") {
        logTranslationEvent("自动切换默认目标语言", {
          detectedSourceLanguageCode: detected,
          nextTargetLanguageCode: "zh-Hans",
        })
        setTargetLanguageCode("zh-Hans")
      }
    })()

    return () => {
      cancelled = true
    }
  }, [hasInput, settings.defaultTargetLanguageCode, sourceLanguageCode, sourceText, targetLanguageCode])

  const selectSourceLanguage = useEffectEvent((code: string) => {
    setSourceLanguageCode(code)
    setErrorText("")
  })

  const selectTargetLanguage = useEffectEvent((code: string) => {
    targetTouchedRef.current = true
    setTargetLanguageCode(code)
    setErrorText("")
  })

  const useTranslation = useEffectEvent(async (translatedText: string) => {
    if (!translatedText || !props.allowsReplacement) return
    finishTranslation(translatedText)
  })

  const toggleSourceExpanded = useEffectEvent(() => {
    setIsSourceExpanded((current) => !current)
  })

  const rerunSingleEngine = useEffectEvent(async (engineId: string) => {
    const engine = visibleEngines.find((item) => item.id === engineId)
    if (!engine || !hasInput) return

    const requestId = requestIdRef.current
    const startedAt = Date.now()
    setErrorText("")
    setEngineResults((current) => current.map((item) => (
      item.engineId === engineId
        ? {
            ...item,
            isTranslating: true,
            errorText: "",
          }
        : item
    )))
    logTranslationEvent("单引擎重试开始", {
      requestId,
      engineId: engine.id,
      engineName: engine.label,
      ...assistantLogOptions(engine),
      sourceLanguageCode,
      targetLanguageCode,
    })

    try {
      const result = await translateEngine(engine, {
        onPartialText: async (text: string) => {
          if (requestId !== requestIdRef.current) return
          updatePartialEngineResult(engine.id, text)
        },
      })
      if (requestId !== requestIdRef.current) return
      logTranslationEvent("单引擎重试成功", {
        requestId,
        engineId: engine.id,
        engineName: engine.label,
        ...assistantLogOptions(engine),
        elapsedMs: Date.now() - startedAt,
        translatedLength: result.translatedText.length,
        translatedPreview: summarizeText(result.translatedText),
      })

      setEngineResults((current) => current.map((item) => (
        item.engineId === engineId ? result : item
      )))
      try {
        HapticFeedback.notificationSuccess()
      } catch {}
    } catch (error) {
      if (requestId !== requestIdRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[Translator] 单引擎重试失败`, {
        requestId,
        engineId: engine.id,
        engineName: engine.label,
        ...assistantLogOptions(engine),
        elapsedMs: Date.now() - startedAt,
        error: message,
      })

      setEngineResults((current) => current.map((item) => (
        item.engineId === engineId
          ? {
              ...item,
              translatedText: "",
              errorText: message,
              isTranslating: false,
            }
          : item
      )))
      try {
        HapticFeedback.notificationError()
      } catch {}
    }
  })

  async function translateWithSingleModel(entry: AiModelPoolEntry) {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setErrorText("")
    setEngineResults([{
      engineId: entry.id,
      engineName: entry.label,
      systemImage: "sparkles",
      translatedText: "",
      errorText: "",
      isTranslating: true,
    }])

    const detected = await detectSourceLanguageCode(sourceText)
    const targetCode = detected === "zh-Hans" || detected === "zh-Hant" ? "en" : "zh-Hans"

    logTranslationEvent("单模型翻译开始", {
      requestId,
      modelId: entry.id,
      modelLabel: entry.label,
      targetLanguageCode: targetCode,
    })

    try {
      const result = await translateWithModelEntry(
        entry,
        {
          sourceText,
          sourceLanguageCode: AUTO_LANGUAGE.code,
          targetLanguageCode: targetCode,
        },
        {
          onPartialText: async (text: string) => {
            if (requestId !== requestIdRef.current) return
            updatePartialEngineResult(entry.id, text)
          },
        }
      )
      if (requestId !== requestIdRef.current) return
      setEngineResults([{
        engineId: entry.id,
        engineName: entry.label,
        systemImage: "sparkles",
        translatedText: result.translatedText,
        errorText: "",
        isTranslating: false,
      }])
      try {
        HapticFeedback.notificationSuccess()
      } catch {}
    } catch (error) {
      if (requestId !== requestIdRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      console.error("[Translator] 单模型翻译失败", { requestId, modelId: entry.id, error: message })
      setEngineResults([{
        engineId: entry.id,
        engineName: entry.label,
        systemImage: "sparkles",
        translatedText: "",
        errorText: message,
        isTranslating: false,
      }])
      setErrorText(message)
      try {
        HapticFeedback.notificationError()
      } catch {}
    }
  }

  // 默认翻译面板内联模型菜单：直接在宿主里弹原生菜单选模型（避免二级 sheet 在
  // 系统默认翻译宿主中无法呈现导致“点不动”）；选完立即用新模型重译并写入激活模型。
  const { entries: availableModels } = useMemo(() => listSortedForPicker(), [])

  const reselectAndRetry = useEffectEvent(async () => {
    if (!hasInput) return
    // 不再使用 presentModelPicker（Navigation.present 在系统翻译宿主中无法弹出）；
    // 而是顺序尝试模型池中的下一个可用模型。
    const currentIdx = selectedModel
      ? availableModels.findIndex((m) => m.id === selectedModel!.id)
      : -1
    const nextIdx = (currentIdx + 1) % Math.max(availableModels.length, 1)
    const next = availableModels[nextIdx]
    if (!next) return
    setSelectedModel(next)
    markUsed(next.id)
    try { setActiveModel(next) } catch {}
    await translateWithSingleModel(next)
  })

  const applyModelById = useEffectEvent((id: string) => {
    const entry = availableModels.find((item) => item.id === id)
    if (!entry) return
    setSelectedModel(entry)
    markUsed(entry.id)
    try {
      setActiveModel(entry)
    } catch {}
    if (hasInput) void translateWithSingleModel(entry)
  })

  // 「AI 翻译」卡选模型：仅写本引擎 config（不 setActiveModel/不 markUsed），重跑该卡。
  const applyAiTranslateModel = useEffectEvent((id: string) => {
    aiTranslateSelectionIdRef.current = id
    setAiTranslateSelectionId(id)
    const engine = settings.engines.find((item) => item.kind === "ai_translate")
    if (!engine) return
    const next = updateEngineConfig(settings, engine.id, {
      ...(engine.config ?? {}),
      selectedPoolEntryId: id,
    })
    setSettings(next)
    try {
      saveTranslatorSettings(next)
    } catch {}
    if (hasInput) void rerunSingleEngine(engine.id)
  })

  // ai_api 卡切本供应商模型：会话内覆盖，重跑该卡。
  const applyEngineModelOverride = useEffectEvent((engineId: string, model: string) => {
    modelOverrideRef.current = { ...modelOverrideRef.current, [engineId]: model }
    setModelOverrideTick((tick) => tick + 1)
    if (hasInput) void rerunSingleEngine(engineId)
  })

  // 为 AI 翻译卡 / AI 接口卡渲染内联模型选择器（其它引擎返回 null）。
  function renderEngineModelPicker(engine: TranslatorEngineEntry | null) {
    if (!engine) return null

    if (engine.kind === "ai_translate") {
      const selected = findPoolEntry(aiTranslateSelectionId)
      return (
        <HStack spacing={12}>
          <Text foregroundStyle="secondaryLabel">模型</Text>
          <Spacer />
          <Menu
            label={
              <HStack spacing={4}>
                <Text
                  foregroundStyle="accentColor"
                  lineLimit={1}
                  truncationMode="tail"
                  allowsTightening
                  frame={{ maxWidth: 180, alignment: "trailing" as any }}
                  multilineTextAlignment="trailing"
                >
                  {selected ? modelEntryLabel(selected) : "选择模型"}
                </Text>
                <Image systemName="chevron.down" font="caption2" foregroundStyle="accentColor" />
              </HStack>
            }
          >
            <Picker
              title="AI 翻译模型"
              value={aiTranslateSelectionId}
              onChanged={(value: string) => applyAiTranslateModel(value)}
            >
              {availableModels.length ? (
                availableModels.map((entry) => (
                  <Text key={entry.id} tag={entry.id}>
                    {modelEntryLabel(entry) || entry.id}
                  </Text>
                ))
              ) : (
                <Text tag="">（模型池为空，请先在设置里添加 AI 接口）</Text>
              )}
            </Picker>
          </Menu>
        </HStack>
      )
    }

    if (engine.kind === "ai_api") {
      const models = listProviderModels(engine.id)
      if (models.length < 2) return null
      const currentModel = modelOverrideRef.current[engine.id] ?? engine.config?.model ?? ""
      void modelOverrideTick
      return (
        <HStack spacing={12}>
          <Text foregroundStyle="secondaryLabel">模型</Text>
          <Spacer />
          <Menu
            label={
              <HStack spacing={4}>
                <Text
                  foregroundStyle="accentColor"
                  lineLimit={1}
                  truncationMode="tail"
                  allowsTightening
                  frame={{ maxWidth: 180, alignment: "trailing" as any }}
                  multilineTextAlignment="trailing"
                >
                  {currentModel || "选择模型"}
                </Text>
                <Image systemName="chevron.down" font="caption2" foregroundStyle="accentColor" />
              </HStack>
            }
          >
            <Picker
              title="本供应商模型"
              value={currentModel}
              onChanged={(value: string) => applyEngineModelOverride(engine.id, value)}
            >
              {models.map((entry) => (
                <Text key={entry.id} tag={entry.model ?? entry.id}>
                  {entry.model || entry.id}
                </Text>
              ))}
            </Picker>
          </Menu>
        </HStack>
      )
    }

    return null
  }

  useEffect(() => {
    if (!props.singleModelMode || !props.requireModelSelection) return
    if (!hasInput) return
    if (didInitModelRef.current) return
    didInitModelRef.current = true
    void runTranslation()
  }, [props.singleModelMode, props.requireModelSelection, hasInput, runTranslation])

  const sourceShouldCollapse = shouldCollapseSourceText(sourceText)
  const listProps = {
    listStyle: "insetGroup" as const,
    scrollContentBackground: props.showsScrollContentBackground
      ? "visible" as const
      : "hidden" as const,
    ...(props.showsScrollContentBackground ? {} : {
      contentMargins: {
        edges: "top" as const,
        insets: 0,
        placement: "scrollContent" as const,
      },
    }),
    translationHost: systemTranslationHost,
    ...(props.embedded ? {} : {
      presentationDetents: ["medium", "large"] as PresentationDetent[],
      presentationDragIndicator: "visible" as const,
      presentationContentInteraction: "resizes" as const,
    }),
    ...(props.navigationTitle ? {
      navigationTitle: props.navigationTitle,
      navigationBarTitleDisplayMode: "inline" as const,
    } : {}),
  }

  if (!hasInput && !props.editableSource) {
    return (
      <List {...listProps}>
        <Section>
          <Text foregroundStyle="secondaryLabel">
            当前宿主没有传入可供翻译的文本。
          </Text>
        </Section>
      </List>
    )
  }

  return (
    <List {...listProps}>
      <Section>
        <HStack spacing={6}>
          <LanguageMenu
            title="源语言"
            value={sourceLanguageCode}
            selectedLabel={sourceLanguageCode === AUTO_LANGUAGE.code
              ? pickerLabel(AUTO_LANGUAGE)
              : pickerLabel([AUTO_LANGUAGE, ...LANGUAGE_OPTIONS].find((option) => option.code === sourceLanguageCode) ?? AUTO_LANGUAGE)}
            onChanged={selectSourceLanguage}
            options={[AUTO_LANGUAGE, ...LANGUAGE_OPTIONS]}
          />
          <Image
            systemName="arrow.right"
            font="caption"
            foregroundStyle="tertiaryLabel"
          />
          <LanguageMenu
            title="目标语言"
            value={targetLanguageCode}
            selectedLabel={pickerLabel(LANGUAGE_OPTIONS.find((option) => option.code === targetLanguageCode) ?? LANGUAGE_OPTIONS[0])}
            onChanged={selectTargetLanguage}
            options={LANGUAGE_OPTIONS}
          />
        </HStack>
        {props.editableSource ? (
          <TextField
            title=""
            value={draftSourceText}
            onChanged={(value: string) => {
              setDraftSourceText(value)
              setErrorText("")
            }}
            prompt="输入要翻译的文本"
            axis="vertical"
          />
        ) : (
          <CopyableTextRow
            text={sourceText}
            lineLimit={sourceShouldCollapse && !isSourceExpanded ? 2 : undefined}
            extraMenuButtons={sourceShouldCollapse ? [
              {
                title: isSourceExpanded ? "收起" : "展开",
                systemImage: isSourceExpanded ? "chevron.up" : "chevron.down",
                action: toggleSourceExpanded,
              },
            ] : undefined}
          />
        )}
      </Section>

      {props.singleModelMode ? (
        <Section>
          <HStack spacing={12}>
            <Text>AI 模型</Text>
            <Spacer />
            <Menu
              label={
                <HStack spacing={4}>
                  <Text
                    foregroundStyle="accentColor"
                    lineLimit={1}
                    truncationMode="tail"
                    allowsTightening
                    frame={{ maxWidth: 180, alignment: "trailing" as any }}
                    multilineTextAlignment="trailing"
                  >
                    {selectedModel ? modelEntryLabel(selectedModel) : "选择模型"}
                  </Text>
                  <Image systemName="chevron.down" font="caption2" foregroundStyle="accentColor" />
                </HStack>
              }
            >
              <Picker
                title="AI 模型"
                value={selectedModel?.id ?? ""}
                onChanged={(value: string) => applyModelById(value)}
              >
                {availableModels.length ? (
                  availableModels.map((entry) => (
                    <Text key={entry.id} tag={entry.id}>
                      {modelEntryLabel(entry) || entry.id}
                    </Text>
                  ))
                ) : (
                  <Text tag="">（模型池为空，请先在设置里添加 AI 接口）</Text>
                )}
              </Picker>
            </Menu>
          </HStack>
        </Section>
      ) : null}

      {!hasInput && props.editableSource ? (
        <Section>
          <Text foregroundStyle="secondaryLabel">
            输入要翻译的文本后，将按当前已启用的引擎输出结果。
          </Text>
        </Section>
      ) : !props.singleModelMode && visibleEngines.length === 0 ? (
        <Section>
          <Text foregroundStyle="secondaryLabel">
            {errorText || "没有启用且可用的翻译引擎。"}
          </Text>
        </Section>
      ) : (
        engineResults.map((result) => {
          const engine = visibleEngines.find((item) => item.id === result.engineId) ?? null
          const picker = renderEngineModelPicker(engine)
          return (
          <Section
            key={result.engineId}
            header={
              <HStack spacing={8}>
                <Image
                  systemName={result.systemImage}
                  font="caption"
                  foregroundStyle="secondaryLabel"
                />
                <Text
                  font="subheadline"
                  foregroundStyle="secondaryLabel"
                >
                  {result.engineName}
                </Text>
              </HStack>
            }
          >
            {picker}
            {result.isTranslating && result.translatedText ? (
              <VStack spacing={10} frame={{ maxWidth: "infinity", alignment: "center" as any }}>
                <CopyableTextRow
                  text={result.translatedText}
                />
                <ProgressView />
              </VStack>
            ) : result.isTranslating ? (
              <VStack spacing={10} frame={{ maxWidth: "infinity", alignment: "center" as any }}>
                <ProgressView />
              </VStack>
            ) : result.translatedText ? (
              <CopyableTextRow
                text={result.translatedText}
                canReplace={props.allowsReplacement}
                onRetranslate={() => {
                  if (props.singleModelMode) {
                    if (selectedModel) void translateWithSingleModel(selectedModel)
                    return
                  }
                  void rerunSingleEngine(result.engineId)
                }}
                onReplace={() => useTranslation(result.translatedText)}
                extraMenuButtons={props.singleModelMode ? [
                  {
                    title: "更换模型重试",
                    systemImage: "arrow.triangle.2.circlepath",
                    action: () => { void reselectAndRetry() },
                  },
                ] : undefined}
              />
            ) : (
              <CopyableTextRow
                text=""
                emptyText={result.errorText || errorText || "暂无译文"}
                foregroundStyle={(result.errorText || errorText) ? "systemRed" : "secondaryLabel"}
                onTapWhenEmpty={() => {
                  if (props.singleModelMode) {
                    if (selectedModel) void translateWithSingleModel(selectedModel)
                    return
                  }
                  void rerunSingleEngine(result.engineId)
                }}
                onRetranslate={() => {
                  if (props.singleModelMode) {
                    if (selectedModel) void translateWithSingleModel(selectedModel)
                    return
                  }
                  void rerunSingleEngine(result.engineId)
                }}
                extraMenuButtons={props.singleModelMode ? [
                  {
                    title: "更换模型重试",
                    systemImage: "arrow.triangle.2.circlepath",
                    action: () => { void reselectAndRetry() },
                  },
                ] : undefined}
              />
            )}
          </Section>
          )
        })
      )}
    </List>
  )
}
