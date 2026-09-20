import {
  Button,
  Device,
  DragGesture,
  GeometryReader,
  Group,
  HStack,
  Script,
  ScrollView,
  Text,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  VStack,
  ZStack,
} from "scripting";
import {
  type ActionSendMode,
  DEFAULT_CANDIDATE_MENU_ACTIONS,
  type KeyboardType,
  loadRimeKeyboardSettings,
  type RimeKeyboardSettings,
  type T9PunctuationItem,
} from "../settings";
import {
  KEY_BACKSPACE,
  KEY_DOWN,
  KEY_ESCAPE,
  KEY_PAGE_DOWN,
  KEY_PAGE_UP,
  KEY_RETURN,
  KEY_SPACE,
  KEY_TAB,
  KEY_UP,
  MOD_CONTROL,
  MOD_SHIFT,
  parseRimeKeySpec,
} from "../rimeKeys";
import {
  BACKSLASH_SYMBOLS,
  LETTER_ROWS,
  NUMERIC_SYMBOLS,
  T9_KEYS,
} from "../keyboardLayout";
import {
  KeyFace,
  KeyPressVisualContext,
  KeyPressVisualController,
  type PressVisualCommit,
} from "./components";
import {
  CandidateHeader,
  type ExpandedCandidateItem,
  ExpandedCandidatePanel,
  type RimeNotificationToast,
} from "./candidateSurface";
import { KEY_SPACING, SIDE_PADDING } from "./constants";
import {
  getActiveModel,
  isModelUsableInKeyboard,
  markUsed,
  modelEntryLabel,
  setActiveModel,
  type AiModelPoolEntry,
} from "./aiModelStore";
import { ModelPickerSurface } from "./modelPicker";
import { PunctSurface } from "./punctSurface";
import { TranslateLangPickerSurface } from "./translateLangPicker";
import {
  getTranslateTargetLangId,
  setTranslateTargetLangId,
  translateLangLabel,
  translateLangName,
} from "./translateLangStore";
import { keyboardMetrics } from "./metrics";
import { type KeyboardAppearance, paletteFor } from "./palette";
import {
  t9DigitsForInput,
  t9DigitsForPinyin,
  type T9FilterState,
  type T9PinyinOption,
  t9PinyinOptionsForFilter,
  t9SelectedDigitPrefix,
} from "./t9Pinyin";
import type { KeyHitTarget } from "./types";
import {
  EMPTY_KEYBOARD_RIME_STATE,
  type KeyboardRimeState,
  RimeViewStateController,
} from "./rimeViewState";
import {
  clearQueuedKeyboardActions,
  createTouchIntentMachine,
  disposeConfiguredHaptics,
  enqueueKeyboardAction,
  getCurrentKeyboardActionDiagnosticContext,
  hapticInterval,
  keyboardActionDiagnosticTimestamp,
  nearestHitTarget,
  playConfiguredClick,
  playConfiguredHaptic,
  playPreparedConfiguredHaptic,
  prepareConfiguredHaptics,
  setKeyboardActionDiagnosticsEnabled,
} from "./utils";
import { ensureT9ProcessorLuaInstalled } from "../t9ProcessorInstall";
import {
  KeyboardPerformanceDiagnostics,
  type PendingPerformanceDiagnosticSample,
  performanceNow,
} from "../performanceDiagnostics";

function currentKeyboardAppearance(): KeyboardAppearance {
  const value = CustomKeyboard.traits?.keyboardAppearance;
  return value === "dark" || value === "light" ? value : "default";
}

let globalRepeatingDeleteTimer: any = null;
let globalRepeatingDeleteSafetyTimer: any = null;
let globalRepeatingDeleteToken = 0;
const SPACE_CURSOR_DRAG_STEP = 18;
const SPACE_CANDIDATE_DRAG_STEP = 24;
const DELETE_LONG_PRESS_DURATION = 920;
const DELETE_REPEAT_SAFETY_DURATION = 4200;
const CURSOR_REPEAT_DURATION = 420;
const PRESSED_STUCK_RELEASE_DELAY = 1800;
const LONG_PRESS_PRESSED_RELEASE_DELAY = 2600;
const EXPANDED_RIME_PAGE_BATCH = 4;
const LETTER_LONG_PRESS_LAYER_GRACE_MS = 900;
const EXIT_ACTION_FEEDBACK_DELAY = 90;
const NUMERIC_DIGIT_ROWS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
];
const NUMERIC_BOTTOM_ROW = ["ABC", "0", "space"];
const T9_KEY_ROWS = [
  T9_KEYS.slice(0, 3),
  T9_KEYS.slice(3, 6),
  T9_KEYS.slice(6, 9),
];

type SelectAllSnapshot = {
  text: string;
  cursorBefore: number;
};

type T9CandidatePinyinFilter = {
  selected: string[];
  preeditCore: string;
};

type RefreshOptions = {
  suppressCommit?: boolean;
  suppressInlineMarkedText?: boolean;
  resetT9FilterFromPreedit?: boolean;
  preserveT9FilterState?: boolean;
  performanceSample?: PendingPerformanceDiagnosticSample;
};

type RimeMetadata = {
  ascii: boolean;
  currentSchemaId: string | null;
};

type KeyboardBodyRimeProjection = RimeMetadata & {
  composing: boolean;
  hasSecondCandidate: boolean;
  hasThirdCandidate: boolean;
  t9Preedit: string;
  t9PreeditCursor: number;
  schemas: Rime.Schema[];
};

const NOTIFIED_RIME_OPTIONS = new Set([
  "ascii_mode",
  "full_shape",
  "simplification",
  "ascii_punct",
]);
const RIME_NOTIFICATION_TOAST_DURATION_MS = 1400;
const RIME_NOTIFICATION_MIN_INTERVAL_MS = 180;
const TOOLBAR_TEMPLATE_CLIPBOARD = "{clipboard}";
const LEGACY_TOOLBAR_TEMPLATE_CLIPBOARD = "{{clipboard}}";
const T9_OPTION_LIMIT = 48;
const ToolbarScriptFunction = Function as unknown as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

function stopGlobalRepeatingDelete() {
  globalRepeatingDeleteToken += 1;
  if (globalRepeatingDeleteTimer != null) {
    clearTimeout(globalRepeatingDeleteTimer);
  }
  if (globalRepeatingDeleteSafetyTimer != null) {
    clearTimeout(globalRepeatingDeleteSafetyTimer);
  }
  globalRepeatingDeleteTimer = null;
  globalRepeatingDeleteSafetyTimer = null;
}

function sameCandidates(
  previous: Rime.Candidate[],
  next: Rime.Candidate[],
) {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (
      previous[index].text !== next[index].text ||
      previous[index].comment !== next[index].comment
    ) {
      return false;
    }
  }
  return true;
}

function sameNumberArray(previous: number[], next: number[]) {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

function t9PreeditCore(preedit: string) {
  return preedit
    .split("〔")[0]
    .replace(/[^0-9A-Za-zvV']+$/g, "");
}

function t9MixedPreeditInputPart(preedit: string) {
  return t9PreeditCore(preedit).match(/[\x20-\x7E]+$/)?.[0] ?? "";
}

function t9PreeditInputPart(preedit: string) {
  return t9PreeditCore(preedit).match(/[0-9A-Za-zvV']+$/)?.[0] ?? "";
}

function t9HasCommittedPrefix(preedit: string) {
  const core = t9PreeditCore(preedit);
  const tail = t9MixedPreeditInputPart(preedit);
  const prefix = tail ? core.slice(0, -tail.length) : core;
  return /[^0-9A-Za-zvV']/.test(prefix);
}

function trailingT9DigitTail(preedit: string) {
  const input = t9PreeditInputPart(preedit);
  const match = input.match(/[1-9]+$/);
  const rawTail = match?.[0] ?? "";
  if (rawTail) {
    return {
      prefix: input.slice(0, -rawTail.length),
      tail: rawTail,
    };
  }
  const pinyinTail = input.match(/[A-Za-zvV]+$/)?.[0] ?? "";
  const tail = pinyinTail ? t9DigitsForPinyin(pinyinTail) : "";
  return {
    prefix: tail ? input.slice(0, -pinyinTail.length) : input,
    tail,
  };
}

function t9FilterFromPreedit(preedit: string): T9FilterState {
  if (t9HasCommittedPrefix(preedit)) {
    return {
      digits: t9DigitsForInput(t9MixedPreeditInputPart(preedit)),
      selected: [],
    };
  }
  const { prefix, tail } = trailingT9DigitTail(preedit);
  const selected = prefix
    .split(/[^A-Za-zvV]+/)
    .filter((item) => item.trim().length > 0);
  return {
    digits: `${t9SelectedDigitPrefix(selected)}${tail}`,
    selected,
  };
}

function t9UnselectedFilterFromPreedit(preedit: string): T9FilterState {
  if (!preedit) return { digits: "", selected: [] };
  const input = t9HasCommittedPrefix(preedit)
    ? t9MixedPreeditInputPart(preedit)
    : t9PreeditCore(preedit);
  return {
    digits: t9DigitsForInput(input),
    selected: [],
  };
}

function t9ResolvedFilterFromPreedit(
  preedit: string,
  filterState?: T9FilterState,
): T9FilterState {
  const hasCommittedPrefix = t9HasCommittedPrefix(preedit);
  const derived = t9FilterFromPreedit(preedit);
  if (!filterState?.digits) return derived;
  if (hasCommittedPrefix) {
    return filterState.digits === derived.digits ? filterState : derived;
  }
  return filterState;
}

function t9PinyinOptionsFromPreedit(
  preedit: string,
  filterState?: T9FilterState,
  candidateFilter?: T9CandidatePinyinFilter | null,
): T9PinyinOption[] {
  const filter = t9ResolvedFilterFromPreedit(preedit, filterState);
  const activeCandidateFilter = candidateFilter?.preeditCore ===
      t9PreeditCore(preedit)
    ? candidateFilter
    : null;
  return t9PinyinOptionsForFilter(
    activeCandidateFilter
      ? { digits: filter.digits, selected: activeCandidateFilter.selected }
      : filter,
    T9_OPTION_LIMIT,
  );
}

function t9GreedyPinyinDisplay(filter: T9FilterState) {
  if (!filter.digits) return "";
  let selected = filter.selected.filter(Boolean);
  let guard = 0;
  while (t9SelectedDigitPrefix(selected).length < filter.digits.length) {
    const options = t9PinyinOptionsForFilter(
      { digits: filter.digits, selected },
      1,
    );
    const next = options[0]?.selected.filter(Boolean) ?? [];
    if (next.length <= selected.length || guard++ > 12) break;
    selected = next;
  }

  const consumed = t9SelectedDigitPrefix(selected);
  const remaining = filter.digits.slice(consumed.length);
  return selected.length > 0
    ? remaining ? `${selected.join("'")}'${remaining}` : selected.join("'")
    : remaining;
}

function t9LocalPreeditDisplay(
  preedit: string,
  filterState?: T9FilterState,
  candidateFilter?: T9CandidatePinyinFilter | null,
) {
  const preeditCore = t9PreeditCore(preedit);
  const isDigitOnlyPreedit = preeditCore.length > 0 &&
    /^[2-9]+$/.test(preeditCore);
  if (!candidateFilter && preedit && !isDigitOnlyPreedit) {
    return null;
  }
  if (
    candidateFilter && candidateFilter.preeditCore !== preeditCore
  ) {
    return null;
  }
  const filter = t9ResolvedFilterFromPreedit(preedit, filterState);
  const selected = (candidateFilter?.selected ?? filter.selected).filter(
    Boolean,
  );
  return t9GreedyPinyinDisplay({ digits: filter.digits, selected }) || null;
}

function withT9VisualDelimiters(text: string, positions: number[]) {
  if (!text || positions.length === 0) return text;
  let output = text;
  let inserted = 0;
  const sorted = [...new Set(positions)]
    .filter((position) => position > 0)
    .sort((a, b) => a - b);
  for (const position of sorted) {
    const index = Math.min(output.length, position + inserted);
    if (output[index - 1] === "'" || output[index] === "'") continue;
    output = `${output.slice(0, index)}'${output.slice(index)}`;
    inserted += 1;
  }
  return output;
}

function t9VisualDelimiterOffset(cursor: number, positions: number[]) {
  return positions.filter((position) => position > 0 && position <= cursor)
    .length;
}

// 模型选择面板：替换功能键行位置，高度等于 functionKeyHeight，
// QWERTY 三行字母键完全不被遮挡，用户可直接点击字母键搜索过滤。
const MODEL_PICKER_EXTRA = 8; // 比功能键行多一点点空间给标题

export function KeyboardView() {
  return (
    <GeometryReader>
      {(proxy) => {
        const height = Number(proxy.size.height || 0) || undefined;
        const width = Number(proxy.size.width || 0) || undefined;
        return (
          <KeyboardContent
            availableHeight={height}
            availableWidth={width}
          />
        );
      }}
    </GeometryReader>
  );
}

function KeyboardContent(props: {
  availableHeight?: number;
  availableWidth?: number;
}) {
  const [settings] = useState<RimeKeyboardSettings>(() =>
    loadRimeKeyboardSettings()
  );
  const [keyboardTypeOverride, setKeyboardTypeOverride] = useState<
    KeyboardType | null
  >(null);
  const activeKeyboardType = keyboardTypeOverride ?? settings.keyboardType;
  const isT9Keyboard = activeKeyboardType === "t9";
  const isT9KeyboardRef = useRef(isT9Keyboard);
  isT9KeyboardRef.current = isT9Keyboard;
  const [keyboardAppearance, setKeyboardAppearance] = useState<
    KeyboardAppearance
  >(() => currentKeyboardAppearance());
  const palette = useMemo(
    () => paletteFor(settings, keyboardAppearance),
    [settings, keyboardAppearance],
  );
  const sessionRef = useRef<Rime.Session | null>(null);
  const rimeMetadataRef = useRef<RimeMetadata>({
    ascii: false,
    currentSchemaId: null,
  });

  const [error, setError] = useState<string | null>(null);
  const rimeViewStateControllerRef = useRef<RimeViewStateController | null>(
    null,
  );
  if (rimeViewStateControllerRef.current == null) {
    rimeViewStateControllerRef.current = new RimeViewStateController();
  }
  const rimeStateRef = useRef<KeyboardRimeState>(EMPTY_KEYBOARD_RIME_STATE);
  const schemasRef = useRef<Rime.Schema[]>([]);
  const rimeProjectionRef = useRef<KeyboardBodyRimeProjection>({
    composing: false,
    hasSecondCandidate: false,
    hasThirdCandidate: false,
    t9Preedit: "",
    t9PreeditCursor: 0,
    ascii: false,
    currentSchemaId: null,
    schemas: schemasRef.current,
  });
  const [rimeProjection, setRimeProjection] = useState<
    KeyboardBodyRimeProjection
  >(rimeProjectionRef.current);
  const {
    composing: rimeComposing,
    hasSecondCandidate,
    hasThirdCandidate,
    t9Preedit,
    t9PreeditCursor,
    ascii,
    currentSchemaId,
    schemas,
  } = rimeProjection;
  const [shifted, setShifted] = useState(false);
  const [capsLocked, setCapsLocked] = useState(false);
  const [symbolLayer, setSymbolLayer] = useState(false);
  const [backslashWrapMode, setBackslashWrapMode] = useState(false);
  const rimeReadyRef = useRef(false);
  const [candidateExpanded, setCandidateExpanded] = useState(false);
  const [expandedCandidates, setExpandedCandidates] = useState<
    ExpandedCandidateItem[]
  >([]);
  const [expandedBatchHasMore, setExpandedBatchHasMore] = useState(false);
  const [selectAllActive, setSelectAllActive] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [translateLangOpen, setTranslateLangOpen] = useState(false);
  const [asciiPunctOn, setAsciiPunctOn] = useState(false);
  const [punctPanelOpen, setPunctPanelOpen] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const aiBusyRef = useRef(false);
  const [activeModelLabel, setActiveModelLabel] = useState<string>(() => {
    const entry = getActiveModel();
    return entry ? (modelEntryLabel(entry) || "AI") : "AI";
  });
  const [rimeNotificationToast, setRimeNotificationToast] = useState<
    RimeNotificationToast | null
  >(null);
  const [t9DelimiterVisualPositions, setT9DelimiterVisualPositions] = useState<
    number[]
  >([]);
  const [t9FilterState, setT9FilterStateValue] = useState<T9FilterState>({
    digits: "",
    selected: [],
  });
  const [t9CandidatePinyinFilter, setT9CandidatePinyinFilter] = useState<
    T9CandidatePinyinFilter | null
  >(null);
  const lastShiftTapRef = useRef(0);
  const deletedTextRef = useRef("");
  const selectAllSnapshotRef = useRef<SelectAllSnapshot | null>(null);
  const cursorRepeatTimerRef = useRef<any>(null);
  const cursorRepeatTokenRef = useRef(0);
  const rimeNotificationTimerRef = useRef<any>(null);
  const rimeNotificationFlushTimerRef = useRef<any>(null);
  const rimeNotificationPendingRef = useRef<RimeNotificationToast | null>(null);
  const lastRimeNotificationShownAtRef = useRef(0);
  const rimeNotificationHandlerRef = useRef<
    ((event: Rime.Event) => void) | null
  >(
    null,
  );
  const rimeOptionStateRef = useRef<Record<string, boolean>>({});
  const t9FilterStateRef = useRef<T9FilterState>({ digits: "", selected: [] });
  const pressedKeyIdsRef = useRef<Set<string>>(new Set());
  const pressVisualControllerRef = useRef<KeyPressVisualController | null>(
    null,
  );
  if (pressVisualControllerRef.current == null) {
    pressVisualControllerRef.current = new KeyPressVisualController();
  }
  const pressedReleaseTimersRef = useRef(new Map<string, any>());
  const activeHitTargetRef = useRef(new Map<string, KeyHitTarget>());
  const rowGestureMachineRef = useRef(new Map<string, any>());
  const rowSpaceDragConsumedRef = useRef(new Map<string, boolean>());
  const rowDiagnosticTouchStartedAtRef = useRef(
    new Map<string, number | undefined>(),
  );
  const hitTargetActionsRef = useRef<Record<string, any>>({});
  const spaceCursorDragXRef = useRef<number | null>(null);
  const lastPressFeedbackAtRef = useRef(0);
  const lastCursorFeedbackAtRef = useRef(0);
  const lastDeleteHapticAtRef = useRef(0);
  const suppressLetterLongPressUntilRef = useRef(
    Date.now() +
      LETTER_LONG_PRESS_LAYER_GRACE_MS,
  );
  const suppressSchemaMenuInlineRef = useRef(false);
  const rimeSetupStartedRef = useRef(false);
  const disposedRef = useRef(false);
  const performanceDiagnosticsRef = useRef<
    KeyboardPerformanceDiagnostics | null
  >(null);
  const pendingRimeRenderSamplesRef = useRef<
    PendingPerformanceDiagnosticSample[]
  >([]);
  if (
    settings.performanceDiagnostics && performanceDiagnosticsRef.current == null
  ) {
    performanceDiagnosticsRef.current = new KeyboardPerformanceDiagnostics();
  }
  const metrics = useMemo(
    () =>
      keyboardMetrics(
        settings,
        props.availableHeight,
        props.availableWidth,
      ),
    [settings, props.availableHeight, props.availableWidth],
  );

  useEffect(() => {
    clearQueuedKeyboardActions();
    stopRepeatingBackspace();
    const syncKeyboardAppearance = (
      traits?: CustomKeyboard.TextInputTraits,
    ) => {
      const value = traits?.keyboardAppearance ??
        CustomKeyboard.traits?.keyboardAppearance;
      setKeyboardAppearance(
        value === "dark" || value === "light" ? value : "default",
      );
    };
    syncKeyboardAppearance();
    CustomKeyboard.addListener("textDidChange", syncKeyboardAppearance);
    CustomKeyboard.addListener("selectionDidChange", syncKeyboardAppearance);
    const hapticPrepareTimer = setTimeout(
      () => prepareConfiguredHaptics(settings),
      0,
    );
    void setupRimeSession();

    return () => {
      disposedRef.current = true;
      clearTimeout(hapticPrepareTimer);
      if (
        rimeNotificationHandlerRef.current &&
        Rime.onNotification === rimeNotificationHandlerRef.current
      ) {
        Rime.onNotification = null;
      }
      rimeNotificationHandlerRef.current = null;
      if (rimeNotificationTimerRef.current != null) {
        clearTimeout(rimeNotificationTimerRef.current);
      }
      if (rimeNotificationFlushTimerRef.current != null) {
        clearTimeout(rimeNotificationFlushTimerRef.current);
      }
      CustomKeyboard.removeListener("textDidChange", syncKeyboardAppearance);
      CustomKeyboard.removeListener(
        "selectionDidChange",
        syncKeyboardAppearance,
      );
      try {
        CustomKeyboard.unmarkText();
      } catch {}
      for (const machine of rowGestureMachineRef.current.values()) {
        machine?.dispose?.();
      }
      rowGestureMachineRef.current.clear();
      rowSpaceDragConsumedRef.current.clear();
      rowDiagnosticTouchStartedAtRef.current.clear();
      stopRepeatingCursorMove();
      for (const timer of pressedReleaseTimersRef.current.values()) {
        clearTimeout(timer);
      }
      pressedReleaseTimersRef.current.clear();
      pressedKeyIdsRef.current.clear();
      pressVisualControllerRef.current?.clear();
      clearQueuedKeyboardActions();
      stopRepeatingBackspace();
      performanceDiagnosticsRef.current?.dispose();
      rimeViewStateControllerRef.current?.dispose();
      setKeyboardActionDiagnosticsEnabled(false);
      disposeConfiguredHaptics();
      sessionRef.current?.close();
      sessionRef.current = null;
      rimeReadyRef.current = false;
    };
  }, []);

  useEffect(() => {
    setKeyboardActionDiagnosticsEnabled(settings.performanceDiagnostics);
  }, [settings.performanceDiagnostics]);

  useEffect(() => {
    const controller = pressVisualControllerRef.current;
    controller?.setCommitListener(
      settings.performanceDiagnostics
        ? (commit: PressVisualCommit) =>
          performanceDiagnosticsRef.current?.recordPressVisualCommit(
            commit,
          )
        : null,
    );
    return () => controller?.setCommitListener(null);
  }, [settings.performanceDiagnostics]);

  const onCandidateRenderCommit = useCallback(() => {
    if (!settings.performanceDiagnostics) return;
    const pending = pendingRimeRenderSamplesRef.current.splice(0);
    for (const sample of pending) {
      performanceDiagnosticsRef.current?.recordRimeRenderCommit(sample);
    }
  }, [settings.performanceDiagnostics]);

  function setT9FilterState(next: T9FilterState) {
    t9FilterStateRef.current = next;
    setT9FilterStateValue(next);
  }

  function readRimeMetadata(session: Rime.Session): RimeMetadata {
    return {
      currentSchemaId: session.currentSchema?.id ?? null,
      ascii: session.getOption("ascii_mode"),
    };
  }

  function cacheRimeMetadata(patch: Partial<RimeMetadata>) {
    rimeMetadataRef.current = {
      ...rimeMetadataRef.current,
      ...patch,
    };
  }

  function publishRimeState(next: KeyboardRimeState, notifyView = true) {
    rimeStateRef.current = next;
    rimeViewStateControllerRef.current?.publish(next, notifyView);
    const previous = rimeProjectionRef.current;
    const nextProjection: KeyboardBodyRimeProjection = {
      ascii: next.ascii,
      currentSchemaId: next.currentSchemaId,
      composing: next.preedit.length > 0,
      hasSecondCandidate: next.candidates.length > 1,
      hasThirdCandidate: next.candidates.length > 2,
      t9Preedit: isT9KeyboardRef.current ? next.preedit : previous.t9Preedit,
      t9PreeditCursor: isT9KeyboardRef.current
        ? next.preeditCursor
        : previous.t9PreeditCursor,
      schemas: schemasRef.current,
    };
    if (
      previous.ascii === nextProjection.ascii &&
      previous.currentSchemaId === nextProjection.currentSchemaId &&
      previous.composing === nextProjection.composing &&
      previous.hasSecondCandidate === nextProjection.hasSecondCandidate &&
      previous.hasThirdCandidate === nextProjection.hasThirdCandidate &&
      previous.t9Preedit === nextProjection.t9Preedit &&
      previous.t9PreeditCursor === nextProjection.t9PreeditCursor &&
      previous.schemas === nextProjection.schemas
    ) return;
    rimeProjectionRef.current = nextProjection;
    setRimeProjection(nextProjection);
  }

  function currentPreedit() {
    return rimeStateRef.current.preedit;
  }

  function currentCandidates() {
    return rimeStateRef.current.candidates;
  }

  function applyRimeMetadata(patch: Partial<RimeMetadata>) {
    cacheRimeMetadata(patch);
    const previous = rimeStateRef.current;
    const nextAscii = patch.ascii ?? previous.ascii;
    const nextSchemaId = patch.currentSchemaId === undefined
      ? previous.currentSchemaId
      : patch.currentSchemaId;
    if (
      previous.ascii === nextAscii &&
      previous.currentSchemaId === nextSchemaId
    ) return;
    const next = {
      ...previous,
      ascii: nextAscii,
      currentSchemaId: nextSchemaId,
    };
    publishRimeState(next, false);
  }

  function clearT9ProcessorSelection(session = sessionRef.current) {
    if (!session) return;
    try {
      session.setProperty("t9_processor_selected", "");
      session.setProperty("t9_processor_digits", "");
    } catch {}
  }

  async function setupRimeSession() {
    if (
      disposedRef.current || rimeSetupStartedRef.current || sessionRef.current
    ) {
      return;
    }
    rimeSetupStartedRef.current = true;
    try {
      const result = await Thread.runInBackground(async () => {
        if (!Rime.isSetUp) await Rime.setup();
        if (settings.keyboardType === "t9") {
          await ensureT9ProcessorLuaInstalled();
        }
        if (settings.autoDeployOnLaunch) {
          await Rime.deploy({ fullCheck: false });
        }
        const list = await Rime.listSchemas();
        const session = new Rime.Session();
        return { list, session };
      });
      if (disposedRef.current) return;
      schemasRef.current = result.list;
      const s = result.session;
      if (disposedRef.current) {
        s.close();
        return;
      }
      sessionRef.current = s;
      rimeMetadataRef.current = readRimeMetadata(s);
      refresh(s);
      try {
        setAsciiPunctOn(s.getOption("ascii_punct"));
      } catch {}
      publishRimeState(rimeStateRef.current);
      if (settings.showNotifications) {
        refreshKnownRimeOptionStates(s);
      }
      installRimeNotificationHandler();
      rimeReadyRef.current = true;
    } catch (e) {
      rimeReadyRef.current = false;
      setError((e as Error).message ?? String(e));
    }
  }

  function updateMarkedText(
    ctx: Rime.Context | null,
    committed: boolean,
    forceUnmark = false,
  ) {
    if (forceUnmark || !settings.inlinePreedit || committed || !ctx?.preedit) {
      try {
        CustomKeyboard.unmarkText();
      } catch {}
      return;
    }
    try {
      CustomKeyboard.setMarkedText(
        ctx.preedit,
        ctx.cursorPos ?? ctx.preedit.length,
        0,
      );
    } catch {}
  }

  function displayedPreeditCursor(preedit: string, cursor: number) {
    const safeCursor = Math.min(preedit.length, Math.max(0, cursor));
    const tipStart = preedit.indexOf("〔");
    if (tipStart > 0 && preedit.indexOf("〕", tipStart + 1) > tipStart) {
      return Math.min(safeCursor, tipStart);
    }
    return safeCursor;
  }

  function refresh(session = sessionRef.current, options: RefreshOptions = {}) {
    if (!session) return;
    const performanceSample = options.performanceSample;
    const refreshStartedAt = performanceSample ? performanceNow() : 0;
    const contextStartedAt = performanceSample ? performanceNow() : 0;
    const ctx = session.context;
    const menu = ctx?.menu;
    const commit = session.commit;
    const contextReadMs = performanceSample
      ? performanceNow() - contextStartedAt
      : 0;
    const committed = Boolean(commit && !options.suppressCommit);
    if (commit && !options.suppressCommit) insertTextReplacingSelectAll(commit);
    updateMarkedText(
      ctx,
      committed,
      Boolean(options.suppressInlineMarkedText) ||
        suppressSchemaMenuInlineRef.current,
    );
    const nextPreedit = ctx?.preedit ?? "";
    const nextCursor = displayedPreeditCursor(
      nextPreedit,
      ctx?.cursorPos ?? nextPreedit.length,
    );
    const nextCandidates = menu?.candidates ?? [];
    const metadata = rimeMetadataRef.current;
    const nextRimeState = {
      preedit: nextPreedit,
      preeditCursor: nextCursor,
      candidates: nextCandidates,
      highlightedIdx: menu?.highlightedIndex ?? 0,
      pageNo: menu?.pageNo ?? 0,
      rimePageSize: menu?.pageSize ?? 5,
      currentSchemaId: metadata.currentSchemaId,
      ascii: metadata.ascii,
    };
    const previous = rimeStateRef.current;
    const comparisonStartedAt = performanceSample ? performanceNow() : 0;
    const viewUnchanged = previous.preedit === nextRimeState.preedit &&
      previous.preeditCursor === nextRimeState.preeditCursor &&
      previous.highlightedIdx === nextRimeState.highlightedIdx &&
      previous.pageNo === nextRimeState.pageNo &&
      previous.rimePageSize === nextRimeState.rimePageSize &&
      sameCandidates(previous.candidates, nextRimeState.candidates);
    const unchanged = viewUnchanged &&
      previous.currentSchemaId === nextRimeState.currentSchemaId &&
      previous.ascii === nextRimeState.ascii;
    const candidateCompareMs = performanceSample
      ? performanceNow() - comparisonStartedAt
      : 0;
    const stateChanged = !unchanged;
    if (stateChanged) {
      if (performanceSample && !viewUnchanged) {
        performanceSample.renderScheduledAt = performanceNow();
        pendingRimeRenderSamplesRef.current.push(performanceSample);
      }
      publishRimeState(nextRimeState, !viewUnchanged);
    }
    if (isT9Keyboard) {
      setT9DelimiterVisualPositions((previous) => {
        const next = nextPreedit
          ? previous.filter((position) => position <= nextPreedit.length)
          : [];
        return sameNumberArray(previous, next) ? previous : next;
      });
    }
    if (isT9Keyboard && options.resetT9FilterFromPreedit) {
      setT9FilterState(t9UnselectedFilterFromPreedit(nextPreedit));
      setT9CandidatePinyinFilter(null);
    }
    if (!nextPreedit) {
      setBackslashWrapMode(false);
      if (isT9Keyboard && !options.preserveT9FilterState) {
        setT9CandidatePinyinFilter(null);
        clearT9ProcessorSelection(session);
        if (
          t9FilterStateRef.current.digits ||
          t9FilterStateRef.current.selected.length > 0
        ) {
          setT9FilterState({ digits: "", selected: [] });
        }
      }
    }
    if (!nextPreedit) {
      suppressSchemaMenuInlineRef.current = false;
      setCandidateExpanded(false);
      setExpandedCandidates((previous) => previous.length > 0 ? [] : previous);
      setExpandedBatchHasMore(false);
    }
    if (performanceSample) {
      const refreshMs = performanceNow() - refreshStartedAt;
      performanceDiagnosticsRef.current?.complete(performanceSample, {
        contextReadMs,
        candidateCompareMs,
        refreshMs,
        stateChanged,
        candidateCount: nextCandidates.length,
        preeditLength: nextPreedit.length,
      });
    }
  }

  function refreshKnownRimeOptionStates(session = sessionRef.current) {
    if (!session) return;
    const nextStates: Record<string, boolean> = {};
    for (const option of NOTIFIED_RIME_OPTIONS) {
      try {
        nextStates[option] = session.getOption(option);
      } catch {}
    }
    rimeOptionStateRef.current = nextStates;
  }

  function installRimeNotificationHandler() {
    if (rimeNotificationHandlerRef.current) return;
    const handler = (event: Rime.Event) => {
      try {
        handleRimeNotification(event);
      } catch {}
    };
    rimeNotificationHandlerRef.current = handler;
    Rime.onNotification = handler;
  }

  function optionNotificationText(option: string, enabled: boolean) {
    switch (option) {
      case "ascii_mode":
        return enabled ? "英文模式" : "中文模式";
      case "full_shape":
        return enabled ? "全角" : "半角";
      case "simplification":
        return enabled ? "简体" : "繁体";
      case "ascii_punct":
        return enabled ? "英文标点" : "中文标点";
      default:
        return `${option} ${enabled ? "开启" : "关闭"}`;
    }
  }

  function shouldShowOptionNotification(option: string, enabled: boolean) {
    if (!NOTIFIED_RIME_OPTIONS.has(option)) return false;
    const previous = rimeOptionStateRef.current[option];
    rimeOptionStateRef.current[option] = enabled;
    return previous !== undefined && previous !== enabled;
  }

  function showRimeNotificationToast(text: string) {
    if (disposedRef.current || !text.trim()) return;
    rimeNotificationPendingRef.current = { id: Date.now(), text };
    if (rimeNotificationFlushTimerRef.current != null) return;
    const elapsed = Date.now() - lastRimeNotificationShownAtRef.current;
    const delay = Math.max(0, RIME_NOTIFICATION_MIN_INTERVAL_MS - elapsed);
    rimeNotificationFlushTimerRef.current = setTimeout(() => {
      rimeNotificationFlushTimerRef.current = null;
      if (disposedRef.current) return;
      const pending = rimeNotificationPendingRef.current;
      rimeNotificationPendingRef.current = null;
      if (!pending) return;
      lastRimeNotificationShownAtRef.current = Date.now();
      if (rimeNotificationTimerRef.current != null) {
        clearTimeout(rimeNotificationTimerRef.current);
      }
      setRimeNotificationToast(pending);
      rimeNotificationTimerRef.current = setTimeout(() => {
        rimeNotificationTimerRef.current = null;
        setRimeNotificationToast(null);
      }, RIME_NOTIFICATION_TOAST_DURATION_MS);
    }, delay);
  }

  function handleRimeNotification(event: Rime.Event) {
    if (event.type === "schemaChanged") {
      rimeOptionStateRef.current = {};
      const session = sessionRef.current;
      applyRimeMetadata({
        currentSchemaId: session?.currentSchema?.id ?? event.schemaId,
        ...(session ? { ascii: session.getOption("ascii_mode") } : {}),
      });
      if (!settings.showNotifications) return;
      const schemaName = event.schemaName ||
        schemasRef.current.find((schema) => schema.id === event.schemaId)
          ?.name ||
        event.schemaId;
      showRimeNotificationToast(schemaName);
    } else if (event.type === "optionChanged") {
      if (event.option === "ascii_mode") {
        applyRimeMetadata({
          ascii: sessionRef.current?.getOption("ascii_mode") ?? event.enabled,
        });
      }
      if (!settings.showNotifications) return;
      if (!shouldShowOptionNotification(event.option, event.enabled)) return;
      showRimeNotificationToast(
        optionNotificationText(event.option, event.enabled),
      );
    }
  }

  function runWithFeedback(action: () => void) {
    stopRepeatingBackspace();
    stopRepeatingCursorMove();
    action();
    playReleaseFeedback();
    playPressFeedback();
  }

  function runWithFeedbackBeforeAction(
    action: () => void,
    delayMs = 0,
  ) {
    stopRepeatingBackspace();
    stopRepeatingCursorMove();
    playReleaseFeedback();
    playPressFeedback(true);
    if (delayMs > 0) setTimeout(action, delayMs);
    else action();
  }

  function playPressFeedback(force = false) {
    if (!settings.haptics) return;
    const now = Date.now();
    if (
      !force &&
      now - lastPressFeedbackAtRef.current < hapticInterval(settings)
    ) {
      return;
    }
    lastPressFeedbackAtRef.current = now;
    playPreparedConfiguredHaptic(settings);
  }

  function playReleaseFeedback() {
    playConfiguredClick(settings);
  }

  function playCursorMoveFeedback() {
    const now = Date.now();
    if (now - lastCursorFeedbackAtRef.current < hapticInterval(settings)) {
      return;
    }
    lastCursorFeedbackAtRef.current = now;
    playConfiguredHaptic(settings);
  }

  function playRepeatingDeleteFeedback() {
    const now = Date.now();
    if (now - lastDeleteHapticAtRef.current >= hapticInterval(settings)) {
      lastDeleteHapticAtRef.current = now;
      playConfiguredHaptic(settings);
    }
    playConfiguredClick(settings);
  }

  function clearPressedReleaseTimer(id: string) {
    const timer = pressedReleaseTimersRef.current.get(id);
    if (timer != null) clearTimeout(timer);
    pressedReleaseTimersRef.current.delete(id);
  }

  function schedulePressedFallbackRelease(id: string, delay: number) {
    clearPressedReleaseTimer(id);
    pressedReleaseTimersRef.current.set(
      id,
      setTimeout(() => {
        pressedReleaseTimersRef.current.delete(id);
        cleanupContinuousActionForKey(id);
        setKeyPressed(id, false);
      }, delay),
    );
  }

  function setKeyPressed(id: string, pressed: boolean) {
    const current = pressedKeyIdsRef.current;
    if (pressed) {
      schedulePressedFallbackRelease(id, PRESSED_STUCK_RELEASE_DELAY);
    } else clearPressedReleaseTimer(id);
    if (pressed === current.has(id)) return;
    if (pressed) current.add(id);
    else current.delete(id);
    pressVisualControllerRef.current?.setPressed(id, pressed);
  }

  function holdKeyPressedUntilRelease(id: string) {
    setKeyPressed(id, true);
    schedulePressedFallbackRelease(id, LONG_PRESS_PRESSED_RELEASE_DELAY);
  }

  function releaseAllPressedKeys() {
    for (const timer of pressedReleaseTimersRef.current.values()) {
      clearTimeout(timer);
    }
    pressedReleaseTimersRef.current.clear();
    performanceDiagnosticsRef.current?.cancelOpenTouches();
    if (pressedKeyIdsRef.current.size === 0) return;
    pressedKeyIdsRef.current.clear();
    pressVisualControllerRef.current?.clear();
  }

  function cleanupContinuousActionForKey(id: string) {
    if (
      id === "backspace" || id === "numeric-backspace" ||
      id === "t9-backspace"
    ) {
      stopRepeatingBackspace();
    } else if (
      id === "idle-left" || id === "idle-right" || id === "func-left" ||
      id === "func-right"
    ) {
      stopRepeatingCursorMove();
    }
  }

  function isPressed(id: string) {
    return pressedKeyIdsRef.current.has(id);
  }

  function pressLiteralLetter(ch: string) {
    if (ascii) {
      insertTextReplacingSelectAll(ch);
      return;
    }
    processKey(ch.charCodeAt(0), ch, true);
    if (backslashWrapMode) setBackslashWrapMode(false);
  }

  function finishLetterLongPress(
    ch: string,
    selected: "lower" | "upper",
  ) {
    if (selected === "lower") pressLiteralLetter(ch);
    else pressUppercaseLetter(ch);
  }

  function suppressLetterLongPress(
    duration = LETTER_LONG_PRESS_LAYER_GRACE_MS,
  ) {
    suppressLetterLongPressUntilRef.current = Date.now() + duration;
  }

  function letterLongPressEnabled() {
    return rimeReadyRef.current &&
      Date.now() >= suppressLetterLongPressUntilRef.current;
  }

  function switchToLetterLayer() {
    suppressLetterLongPress();
    clearAllRowGestureState();
    releaseAllPressedKeys();
    setSymbolLayer(false);
  }

  function toggleSymbolLayer() {
    if (symbolLayer) switchToLetterLayer();
    else {
      releaseAllPressedKeys();
      setSymbolLayer(true);
    }
  }

  function beginKeyTouch(id: string) {
    if (settings.performanceDiagnostics) {
      performanceDiagnosticsRef.current?.recordTouchStart(id);
    }
    stopRepeatingBackspace();
    stopRepeatingCursorMove();
    setKeyPressed(id, true);
    playPressFeedback();
  }

  function endKeyTouch(id: string) {
    if (settings.performanceDiagnostics) {
      performanceDiagnosticsRef.current?.recordTouchEnd(id);
    }
    if (
      id === "backspace" || id === "numeric-backspace" ||
      id === "t9-backspace"
    ) {
      stopRepeatingBackspace();
    }
    playReleaseFeedback();
    setKeyPressed(id, false);
  }

  function currentSwipeTriggerDistance() {
    return settings.swipeTriggerDistance;
  }

  function isSpaceCursorKey(id: string | undefined) {
    return id === "space" || id === "numeric-space";
  }

  function hitTargetFromGesture(details: any, targets: KeyHitTarget[]) {
    const x = Number(details?.startLocation?.x ?? details?.location?.x ?? 0);
    const y = Number(details?.startLocation?.y ?? details?.location?.y ?? 0);
    return nearestHitTarget(x, y, targets);
  }

  function horizontalHitFrame(
    x: number,
    width: number,
    index: number,
    count: number,
    leadingInset = 0,
    trailingInset = 0,
  ) {
    const leading = index === 0 ? leadingInset : KEY_SPACING / 2;
    const trailing = index === count - 1 ? trailingInset : KEY_SPACING / 2;
    return { x: x - leading, width: width + leading + trailing };
  }

  function verticalHitFrame(
    y: number,
    height: number,
    index: number,
    count: number,
    spacing = KEY_SPACING,
  ) {
    const leading = index === 0 ? 0 : spacing / 2;
    const trailing = index === count - 1 ? 0 : spacing / 2;
    return { y: y - leading, height: height + leading + trailing };
  }

  function verticalTouchFrame(
    index: number,
    count: number,
    height: number,
    spacing: number,
  ) {
    const top = index === 0 ? 0 : spacing / 2;
    const bottom = index === count - 1 ? 0 : spacing / 2;
    return {
      touchHeight: height + top + bottom,
      visualOffsetY: top,
    };
  }

  function getRowGestureMachine(rowId: string) {
    let machine = rowGestureMachineRef.current.get(rowId);
    if (machine) return machine;
    machine = createTouchIntentMachine({
      longPressDuration: () =>
        activeHitTargetRef.current.get(rowId)?.longPressDuration ?? 360,
      swipeTriggerDistance: () => currentSwipeTriggerDistance(),
      safetyReleaseDelay: () => {
        const target = activeHitTargetRef.current.get(rowId);
        return target?.safetyReleaseDelay ??
          (target?.onLongPress ? 1500 : 520);
      },
      longPressSafetyReleaseDelay: () => LONG_PRESS_PRESSED_RELEASE_DELAY,
      shouldCancelLongPress: (details: any) => {
        const target = activeHitTargetRef.current.get(rowId);
        const isSpace = isSpaceCursorKey(target?.id);
        return isSpace
          ? isVerticalDragIntent(details)
          : isLongPressDragIntent(details);
      },
      onTouchEnd: () => {
        clearRowTracking(rowId);
      },
      onLongPress: () => {
        const target = activeHitTargetRef.current.get(rowId);
        if (!target?.onLongPress) return;
        if (target.onLongPressEnd) {
          holdKeyPressedUntilRelease(target.id);
        }
        target.onLongPress();
      },
      onLongPressEnd: () => {
        const target = activeHitTargetRef.current.get(rowId);
        if (!target) return;
        target.onLongPressEnd?.();
      },
      onLongPressMove: (details: any) => {
        const activeId = activeHitTargetRef.current.get(rowId)?.id;
        if (isSpaceCursorKey(activeId)) {
          void updateSpaceLongPressDrag(details);
        } else if (
          activeId === "backspace" || activeId === "numeric-backspace"
        ) {
          backspaceLongPressMove(details);
        }
      },
      onResolveSwipe: (
        direction: "up" | "down" | "left" | "right",
      ) => {
        const target = activeHitTargetRef.current.get(rowId);
        if (!target) return false;
        const action = direction === "up" && target.onSwipeUp
          ? target.onSwipeUp
          : direction === "down" && target.onSwipeDown
          ? target.onSwipeDown
          : direction === "left" && target.onSwipeLeft
          ? target.onSwipeLeft
          : direction === "right" && target.onSwipeRight
          ? target.onSwipeRight
          : null;
        if (!action) return false;
        const touchStartedAt = settings.performanceDiagnostics
          ? rowDiagnosticTouchStartedAtRef.current.get(rowId)
          : undefined;
        playReleaseFeedback();
        setKeyPressed(target.id, false);
        clearRowTracking(rowId, true);
        enqueueKeyboardAction(
          action,
          target.id,
          `swipe-${direction}`,
          touchStartedAt,
        );
        return true;
      },
      onPress: () => {
        const target = activeHitTargetRef.current.get(rowId);
        if (!target) return;
        const touchStartedAt = settings.performanceDiagnostics
          ? rowDiagnosticTouchStartedAtRef.current.get(rowId)
          : undefined;
        playReleaseFeedback();
        setKeyPressed(target.id, false);
        clearRowTracking(rowId, true);
        enqueueKeyboardAction(
          target.onPress,
          target.id,
          "tap",
          touchStartedAt,
        );
      },
    });
    rowGestureMachineRef.current.set(rowId, machine);
    return machine;
  }

  function clearAllRowGestureState() {
    for (const machine of rowGestureMachineRef.current.values()) {
      machine?.cancel?.();
    }
    rowGestureMachineRef.current.clear();
    rowSpaceDragConsumedRef.current.clear();
    rowDiagnosticTouchStartedAtRef.current.clear();
    activeHitTargetRef.current.clear();
    spaceCursorDragXRef.current = null;
  }

  function clearRowTracking(rowId: string, keepVisual = false) {
    const target = activeHitTargetRef.current.get(rowId);
    if (target && settings.performanceDiagnostics) {
      performanceDiagnosticsRef.current?.recordTouchEnd(target.id);
      rowDiagnosticTouchStartedAtRef.current.delete(rowId);
    }
    if (target && !keepVisual) setKeyPressed(target.id, false);
    rowSpaceDragConsumedRef.current.delete(rowId);
    activeHitTargetRef.current.delete(rowId);
    if (target?.id === "backspace" || target?.id === "numeric-backspace") {
      stopRepeatingBackspace();
    }
    if (
      target?.id === "idle-left" || target?.id === "idle-right" ||
      target?.id === "func-left" || target?.id === "func-right"
    ) {
      stopRepeatingCursorMove();
    }
    if (isSpaceCursorKey(target?.id)) spaceCursorDragXRef.current = null;
  }

  function isLongPressDragIntent(details: any) {
    const dx = Math.abs(Number(details?.translation?.width ?? 0));
    const dy = Math.abs(Number(details?.translation?.height ?? 0));
    const vx = Math.abs(Number(details?.velocity?.width ?? 0));
    const vy = Math.abs(Number(details?.velocity?.height ?? 0));
    const predictedDx = Math.abs(
      Number(details?.predictedEndTranslation?.width ?? 0),
    );
    const predictedDy = Math.abs(
      Number(details?.predictedEndTranslation?.height ?? 0),
    );
    return (
      dx >= 4 ||
      dy >= 4 ||
      vx >= 8 ||
      vy >= 8 ||
      predictedDx >= 8 ||
      predictedDy >= 8
    );
  }

  function isVerticalDragIntent(details: any) {
    const dy = Math.abs(Number(details?.translation?.height ?? 0));
    const vy = Math.abs(Number(details?.velocity?.height ?? 0));
    const predictedDy = Math.abs(
      Number(details?.predictedEndTranslation?.height ?? 0),
    );
    return dy >= 4 || vy >= 8 || predictedDy >= 8;
  }

  function cancelRowLongPressIfDragging(rowId: string, details: any) {
    const machine = getRowGestureMachine(rowId);
    if (machine.getState() !== "pending") {
      return;
    }
    const target = activeHitTargetRef.current.get(rowId);
    const isSpace = isSpaceCursorKey(target?.id);
    if (
      isSpace ? !isVerticalDragIntent(details) : !isLongPressDragIntent(details)
    ) {
      return;
    }
    machine.update(details);
  }

  function moveHighlightedCandidateBySpaceDrag(steps: number) {
    const s = sessionRef.current;
    const menu = s?.context?.menu;
    if (!s || !menu) return false;
    const beforePage = menu.pageNo ?? 0;
    const beforeIndex = menu.highlightedIndex ?? 0;
    const count = Math.min(8, Math.abs(steps));
    const key = steps > 0 ? KEY_DOWN : KEY_UP;
    for (let i = 0; i < count; i += 1) {
      s.processKey(key);
    }
    const nextMenu = s.context?.menu;
    const moved = !!nextMenu &&
      ((nextMenu.pageNo ?? 0) !== beforePage ||
        (nextMenu.highlightedIndex ?? 0) !== beforeIndex);
    refresh(s);
    if (moved) playCursorMoveFeedback();
    return moved;
  }

  function moveHostCursorByDrag(direction: number) {
    if (direction < 0 && !(CustomKeyboard.textBeforeCursor ?? "")) {
      return false;
    }
    if (direction > 0 && !(CustomKeyboard.textAfterCursor ?? "")) {
      return false;
    }
    if (!moveCursorSafely(direction)) return false;
    playCursorMoveFeedback();
    return true;
  }

  function updateSpaceLongPressDrag(details: any) {
    const x = Number(details?.location?.x ?? details?.startLocation?.x ?? 0);
    if (spaceCursorDragXRef.current == null) {
      spaceCursorDragXRef.current = Number(details?.startLocation?.x ?? x);
    }
    const hasCandidateNavigation = currentPreedit().length > 0 &&
      currentCandidates().length > 0;
    const stepSize = hasCandidateNavigation
      ? SPACE_CANDIDATE_DRAG_STEP
      : SPACE_CURSOR_DRAG_STEP;
    const dx = x - spaceCursorDragXRef.current;
    const steps = Math.trunc(dx / stepSize);
    if (steps === 0) return false;
    const direction = steps < 0 ? -1 : 1;
    const moved = hasCandidateNavigation
      ? moveHighlightedCandidateBySpaceDrag(direction)
      : moveHostCursorByDrag(direction);
    spaceCursorDragXRef.current += direction * stepSize;
    return moved;
  }

  function trackImmediateSpaceDrag(details: any, consumed = false) {
    const dx = Math.abs(Number(details?.translation?.width ?? 0));
    const dy = Math.abs(Number(details?.translation?.height ?? 0));
    const hasHorizontalDragIntent = dx >= SPACE_CURSOR_DRAG_STEP && dx >= dy;
    if (!consumed && !hasHorizontalDragIntent) return false;
    return updateSpaceLongPressDrag(details) || consumed ||
      hasHorizontalDragIntent;
  }

  function handleHitRowGestureChanged(
    rowId: string,
    details: any,
    targets: KeyHitTarget[],
  ) {
    const machine = getRowGestureMachine(rowId);
    if (machine.getState() === "longpress_locked") {
      machine.update(details);
      return;
    }
    const activeTarget = activeHitTargetRef.current.get(rowId);
    if (activeTarget) {
      machine.update(details);
      if (isSpaceCursorKey(activeTarget.id)) {
        const consumed = rowSpaceDragConsumedRef.current.get(rowId) ?? false;
        if (trackImmediateSpaceDrag(details, consumed)) {
          rowSpaceDragConsumedRef.current.set(rowId, true);
          machine.cancel();
          return;
        }
      }
      cancelRowLongPressIfDragging(rowId, details);
      return;
    }
    const target = hitTargetFromGesture(details, targets);
    if (target) activeHitTargetRef.current.set(rowId, target);
    else activeHitTargetRef.current.delete(rowId);
    if (target) {
      if (settings.performanceDiagnostics) {
        performanceDiagnosticsRef.current?.recordTouchStart(target.id);
        rowDiagnosticTouchStartedAtRef.current.set(
          rowId,
          keyboardActionDiagnosticTimestamp(),
        );
      }
      setKeyPressed(target.id, true);
      playPressFeedback();
      rowSpaceDragConsumedRef.current.set(rowId, false);
      spaceCursorDragXRef.current = null;
      machine.start();
      machine.update(details);
    }
  }

  function handleHitRowGestureEnded(
    rowId: string,
    details: any,
    targets: KeyHitTarget[],
  ) {
    const machine = getRowGestureMachine(rowId);
    const target = activeHitTargetRef.current.get(rowId) ??
      hitTargetFromGesture(details, targets);
    if (!target) {
      machine.cancel();
      clearRowTracking(rowId);
      return;
    }
    if (
      isSpaceCursorKey(target.id) && rowSpaceDragConsumedRef.current.get(rowId)
    ) {
      setKeyPressed(target.id, false);
      machine.cancel();
      clearRowTracking(rowId, true);
      return;
    }
    machine.end(details);
  }

  function hitRowGesture(rowId: string, targets: KeyHitTarget[]) {
    return {
      gesture: DragGesture({
        minDistance: 0,
        coordinateSpace: "local",
      })
        .onChanged((details: any) =>
          handleHitRowGestureChanged(rowId, details, targets)
        )
        .onEnded((details: any) =>
          handleHitRowGestureEnded(rowId, details, targets)
        ),
      mask: "gesture" as any,
    };
  }

  function processSessionKey(
    session: Rime.Session,
    keyCode: number,
    modifiers: number | undefined,
    refreshOptions: RefreshOptions,
    diagnosticAction: string,
  ) {
    const performanceSample = settings.performanceDiagnostics
      ? performanceDiagnosticsRef.current?.begin(
        diagnosticAction,
        activeKeyboardType,
        getCurrentKeyboardActionDiagnosticContext(),
      ) ?? null
      : null;
    const processStartedAt = performanceSample ? performanceNow() : 0;
    const consumed = session.processKey(keyCode, modifiers);
    if (performanceSample) {
      performanceSample.processKeyMs = performanceNow() - processStartedAt;
      refresh(session, { ...refreshOptions, performanceSample });
    } else {
      refresh(session, refreshOptions);
    }
    return consumed;
  }

  function processKey(
    keyCode: number,
    fallback?: string,
    replaceSelectAll = false,
    refreshOptions: RefreshOptions = {},
  ) {
    if (replaceSelectAll) consumeSelectAllForReplacement();
    else clearSelectAllStateForExternalAction();
    const s = sessionRef.current;
    if (!s) {
      if (fallback) insertTextReplacingSelectAll(fallback);
      return;
    }
    const consumed = processSessionKey(
      s,
      keyCode,
      undefined,
      refreshOptions,
      "key",
    );
    if (!consumed && fallback) insertTextReplacingSelectAll(fallback);
  }

  function processKeyWithModifiers(
    keyCode: number,
    modifiers: number,
    refreshOptions: RefreshOptions = {},
  ) {
    clearSelectAllStateForExternalAction();
    const s = sessionRef.current;
    if (!s) return;
    processSessionKey(
      s,
      keyCode,
      modifiers,
      refreshOptions,
      "modifiedKey",
    );
  }

  function processRimeKeySpec(action: string): boolean {
    const spec = parseRimeKeySpec(action);
    if (!spec) return false;
    processKeyWithModifiers(spec.keyCode, spec.modifiers);
    return true;
  }

  function insertConfiguredText(action: string) {
    const text = action
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t");
    if (text) {
      insertTextReplacingSelectAll(text);
    }
  }

  function processText(text: string) {
    if (!text) return;
    if (processRimeKeySpec(text)) return;
    if (text === "\t") {
      processKey(KEY_TAB, "\t");
      return;
    }
    for (const ch of text) processKey(ch.charCodeAt(0), ch, true);
  }

  function processTextThroughRime(text: string) {
    if (!text) return;
    const spec = parseRimeKeySpec(text);
    const s = sessionRef.current;
    if (spec) {
      if (!s) return;
      clearSelectAllStateForExternalAction();
      s.processKey(spec.keyCode, spec.modifiers);
      refresh(s);
      return;
    }
    const normalized = text
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t");
    for (const ch of normalized) {
      if (ch === "\t") processKey(KEY_TAB, "\t");
      else processKey(ch.charCodeAt(0), ch, true);
    }
  }

  function pressLetter(ch: string) {
    const typed = shifted || capsLocked ? ch.toUpperCase() : ch;
    if (modelPickerOpen) {
      setModelSearchQuery((q) => q + typed);
      if (shifted && !capsLocked) setShifted(false);
      return;
    }
    if (ascii) {
      insertTextReplacingSelectAll(typed);
      if (shifted && !capsLocked) setShifted(false);
      return;
    }
    processKey(
      typed.charCodeAt(0),
      typed,
      true,
    );
    if (backslashWrapMode) setBackslashWrapMode(false);
    if (shifted && !capsLocked) setShifted(false);
  }

  function pressUppercaseLetter(ch: string) {
    const typed = ch.toUpperCase();
    if (modelPickerOpen) {
      setModelSearchQuery((q) => q + typed);
      return;
    }
    if (ascii) {
      insertTextReplacingSelectAll(typed);
      return;
    }
    processKey(
      typed.charCodeAt(0),
      typed,
      true,
    );
    if (backslashWrapMode) setBackslashWrapMode(false);
  }

  function pressSymbol(text: string) {
    if (ascii || currentPreedit().length === 0) {
      insertTextReplacingSelectAll(text);
      return;
    }
    processText(text);
  }

  function pressNumericDot() {
    if (!ascii && currentPreedit().length > 0) {
      processText(".");
      return;
    }
    insertTextReplacingSelectAll(".");
  }

  function pressRimePunctuation(text: string) {
    if (ascii) insertTextReplacingSelectAll(text);
    else processTextThroughRime(text);
  }

  function pressKeyboardComma() {
    pressRimePunctuation(isT9Keyboard ? "，" : ",");
  }

  function pressKeyboardPeriod() {
    pressRimePunctuation(isT9Keyboard ? "。" : ".");
  }

  function pressBackspace() {
    if (modelPickerOpen) {
      setModelSearchQuery((q) => q.slice(0, -1));
      return;
    }
    const s = sessionRef.current;
    if (s && (s.context?.preedit?.length ?? 0) > 0) {
      if (isT9Keyboard) setT9CandidatePinyinFilter(null);
      processSessionKey(
        s,
        KEY_BACKSPACE,
        undefined,
        { resetT9FilterFromPreedit: isT9Keyboard },
        "backspace",
      );
    } else {
      if (consumeSelectAllForDeletion()) return;
      const before = CustomKeyboard.textBeforeCursor ?? "";
      deletedTextRef.current = before.slice(-1) || deletedTextRef.current;
      CustomKeyboard.deleteBackward();
    }
  }

  function stopRepeatingBackspace() {
    stopGlobalRepeatingDelete();
  }

  function stopRepeatingCursorMove() {
    cursorRepeatTokenRef.current += 1;
    if (cursorRepeatTimerRef.current != null) {
      clearTimeout(cursorRepeatTimerRef.current);
    }
    cursorRepeatTimerRef.current = null;
  }

  function startRepeatingBackspace(
    id: "backspace" | "numeric-backspace" | "t9-backspace" = "backspace",
  ) {
    stopRepeatingBackspace();
    stopRepeatingCursorMove();
    const repeatToken = ++globalRepeatingDeleteToken;
    lastDeleteHapticAtRef.current = 0;
    pressBackspace();
    playRepeatingDeleteFeedback();
    const repeat = () => {
      if (repeatToken !== globalRepeatingDeleteToken) return;
      pressBackspace();
      playRepeatingDeleteFeedback();
      if (repeatToken !== globalRepeatingDeleteToken) return;
      globalRepeatingDeleteTimer = setTimeout(repeat, 82);
    };
    globalRepeatingDeleteTimer = setTimeout(repeat, 82);
    globalRepeatingDeleteSafetyTimer = setTimeout(() => {
      if (repeatToken !== globalRepeatingDeleteToken) return;
      stopRepeatingBackspace();
      setKeyPressed(id, false);
    }, DELETE_REPEAT_SAFETY_DURATION);
  }

  function startRepeatingCursorMove(offset: number) {
    stopRepeatingCursorMove();
    stopRepeatingBackspace();
    const repeatToken = ++cursorRepeatTokenRef.current;
    const repeat = () => {
      if (repeatToken !== cursorRepeatTokenRef.current) return;
      if (!moveCursorSafely(offset)) return;
      playCursorMoveFeedback();
      cursorRepeatTimerRef.current = setTimeout(repeat, 72);
    };
    repeat();
  }

  function clearComposition() {
    stopRepeatingBackspace();
    const s = sessionRef.current;
    if (s) {
      try {
        s.clearComposition();
        s.processKey(KEY_ESCAPE);
      } catch {}
      refresh(s);
    }
    const nextRimeState = {
      ...rimeStateRef.current,
      preedit: "",
      preeditCursor: 0,
      candidates: [],
      highlightedIdx: 0,
      pageNo: 0,
    };
    publishRimeState(nextRimeState);
    setCandidateExpanded(false);
    setExpandedCandidates([]);
    setExpandedBatchHasMore(false);
    setBackslashWrapMode(false);
    if (isT9Keyboard) clearT9ProcessorSelection(s);
    try {
      CustomKeyboard.setMarkedText("", 0, 0);
      CustomKeyboard.unmarkText();
    } catch {}
  }

  function pressSpace() {
    if (modelPickerOpen) {
      setModelSearchQuery((q) => q + " ");
      return;
    }
    const s = sessionRef.current;
    if (ascii) {
      insertTextReplacingSelectAll(" ");
      return;
    }
    if (s && (s.context?.preedit?.length ?? 0) > 0) {
      processSessionKey(s, KEY_SPACE, undefined, {}, "space");
    } else {
      insertTextReplacingSelectAll(" ");
    }
  }

  function pressReturn() {
    processKey(KEY_RETURN, "\n", true);
  }

  function insertNewline() {
    insertTextReplacingSelectAll("\n");
  }

  function backspaceLongPressMove(details: any) {
    const dx = Math.abs(Number(details?.translation?.width ?? 0));
    const dy = Math.abs(Number(details?.translation?.height ?? 0));
    const vx = Math.abs(Number(details?.velocity?.width ?? 0));
    const vy = Math.abs(Number(details?.velocity?.height ?? 0));
    const predictedDx = Math.abs(
      Number(details?.predictedEndTranslation?.width ?? 0),
    );
    const predictedDy = Math.abs(
      Number(details?.predictedEndTranslation?.height ?? 0),
    );
    if (
      dx >= 5 || dy >= 5 || vx >= 8 || vy >= 8 || predictedDx >= 8 ||
      predictedDy >= 8
    ) {
      stopRepeatingBackspace();
    }
  }

  function backspaceSwipeLeft() {
    stopRepeatingBackspace();
    runConfiguredAction(
      settings.backspaceSwipeLeft,
      settings.backspaceSwipeLeftMode,
    );
  }

  function backspaceSwipeUp() {
    stopRepeatingBackspace();
    if (currentPreedit().length > 0) {
      runConfiguredAction(
        settings.backspaceComposingSwipeUp,
        settings.backspaceComposingSwipeUpMode,
      );
      return;
    }
    runConfiguredAction(
      settings.backspaceSwipeUp,
      settings.backspaceSwipeUpMode,
    );
  }

  function backspaceSwipeDown() {
    stopRepeatingBackspace();
    runConfiguredAction(
      settings.backspaceSwipeDown,
      settings.backspaceSwipeDownMode,
    );
  }

  function toggleAscii() {
    const s = sessionRef.current;
    if (!s) return;
    if (currentPreedit()) clearComposition();
    const next = !ascii;
    s.setOption("ascii_mode", next);
    cacheRimeMetadata({ ascii: next });
    setShifted(false);
    setCapsLocked(false);
    refresh(s);
  }

  // 中文/英文标点切换：直接设置 Rime 的 ascii_punct 选项（false=中文标点，true=英文标点）。
  function setAsciiPunct(enabled: boolean) {
    const s = sessionRef.current;
    if (!s) return;
    if (currentPreedit()) clearComposition();
    try {
      s.setOption("ascii_punct", enabled);
    } catch {}
    setAsciiPunctOn(enabled);
    refresh(s);
    showRimeNotificationToast(
      enabled
        ? "英文标点： , . ? ! ( ) ~"
        : "中文标点： ， 。 ？ ！ （ ） 、 ～",
    );
  }

  // 单个按键在中/英标点之间来回切换（供功能行 {togglePunct} 使用）。
  function togglePunct() {
    const s = sessionRef.current;
    if (!s) return;
    let current = false;
    try {
      current = s.getOption("ascii_punct");
    } catch {}
    setAsciiPunct(!current);
  }

  function switchT9ToEnglishQwerty() {
    setKeyboardTypeOverride("qwerty");
    setSymbolLayer(false);
    const s = sessionRef.current;
    if (!s) return;
    if (currentPreedit()) clearComposition();
    if (!ascii) {
      s.setOption("ascii_mode", true);
      cacheRimeMetadata({ ascii: true });
      setShifted(false);
      setCapsLocked(false);
      refresh(s);
    }
  }

  function switchEnglishQwertyToT9() {
    setKeyboardTypeOverride(null);
    setSymbolLayer(false);
    const s = sessionRef.current;
    if (!s) return;
    if (currentPreedit()) clearComposition();
    if (ascii) {
      s.setOption("ascii_mode", false);
      cacheRimeMetadata({ ascii: false });
      setShifted(false);
      setCapsLocked(false);
      refresh(s);
    }
  }

  function pressShift() {
    if (composing && settings.shiftComposingEnabled) {
      runConfiguredAction(
        settings.shiftComposingKey,
        settings.shiftComposingKeyMode,
      );
      return;
    }
    const now = Date.now();
    if (capsLocked) {
      setCapsLocked(false);
      setShifted(false);
    } else if (now - lastShiftTapRef.current < 430) {
      setCapsLocked(true);
      setShifted(true);
    } else {
      setShifted((value) => !value);
    }
    lastShiftTapRef.current = now;
  }

  function switchSchema(id: string) {
    const s = sessionRef.current;
    if (!s) return;
    s.clearComposition();
    if (s.selectSchema(id)) cacheRimeMetadata({ currentSchemaId: id });
    if (settings.showNotifications) refreshKnownRimeOptionStates(s);
    refresh(s);
  }

  function selectCandidateOnPage(index: number) {
    const s = sessionRef.current;
    if (!s) return;
    if (s.selectCandidateOnCurrentPage(index)) refresh(s);
  }

  function selectCandidateByKey(key: string): boolean {
    const s = sessionRef.current;
    if (!s || !s.context?.preedit) return false;
    const selectKeys = s.context.selectKeys || "1234567890";
    const index = selectKeys.indexOf(key);
    if (index < 0) return false;
    if (!s.context.menu?.candidates[index]) return false;
    if (!s.selectCandidateOnCurrentPage(index)) return false;
    refresh(s);
    return true;
  }

  function selectCandidateAbsolute(index: number) {
    const s = sessionRef.current;
    if (!s) return;
    if (s.selectCandidate(index)) refresh(s);
  }

  function highlightCandidateAbsolute(index: number): boolean {
    const s = sessionRef.current;
    let menu = s?.context?.menu;
    if (!s || !menu) return false;
    const pageSize = Math.max(
      1,
      menu.pageSize || rimeStateRef.current.rimePageSize || 1,
    );
    const targetPage = Math.floor(index / pageSize);
    const targetIndex = index % pageSize;

    while (menu.pageNo < targetPage) {
      if (menu.isLastPage || !s.processKey(KEY_PAGE_DOWN)) break;
      menu = s.context?.menu ?? null;
      if (!menu) return false;
    }
    while (menu.pageNo > targetPage) {
      if (!s.processKey(KEY_PAGE_UP)) break;
      menu = s.context?.menu ?? null;
      if (!menu) return false;
    }
    if (menu.pageNo !== targetPage) {
      refresh(s);
      return false;
    }
    if (!menu.candidates[targetIndex]) {
      refresh(s);
      return false;
    }

    let current = menu.highlightedIndex ?? 0;
    const key = targetIndex > current ? KEY_DOWN : KEY_UP;
    while (current !== targetIndex) {
      if (!s.processKey(key)) break;
      menu = s.context?.menu ?? null;
      if (!menu) return false;
      current = menu.highlightedIndex ?? current;
      if (menu.pageNo !== targetPage) break;
    }
    refresh(s);
    return s.context?.menu?.pageNo === targetPage &&
      s.context?.menu?.highlightedIndex === targetIndex;
  }

  function processSpaceSwipeCandidate(numberKey: "2" | "3") {
    if (currentPreedit()) {
      if (selectCandidateByKey(numberKey)) return;
      processKey(numberKey.charCodeAt(0), numberKey);
      return;
    }
    selectCandidateOnPage(numberKey === "2" ? 1 : 2);
  }

  function canSpaceSwipeCandidate(numberKey: "2" | "3") {
    const index = numberKey === "2" ? 1 : 2;
    return currentPreedit().length > 0 && currentCandidates().length > index;
  }

  function hasLiveComposition() {
    return (sessionRef.current?.context?.preedit?.length ?? 0) > 0 ||
      currentPreedit().length > 0;
  }

  function runT9SpaceSwipe(direction: "up" | "down") {
    const numberKey = direction === "up" ? "2" : "3";
    const candidateIndex = direction === "up" ? 1 : 2;
    const liveCandidates = sessionRef.current?.context?.menu?.candidates ??
      currentCandidates();
    if (hasLiveComposition()) {
      if (liveCandidates.length > candidateIndex) {
        processSpaceSwipeCandidate(numberKey);
      }
      return;
    }
    if (direction === "up") {
      runConfiguredAction(settings.t9SpaceSwipeUp, settings.t9SpaceSwipeUpMode);
    } else {
      runConfiguredAction(
        settings.t9SpaceSwipeDown,
        settings.t9SpaceSwipeDownMode,
      );
    }
  }

  function pressNumericDigit(value: string) {
    pressSymbol(value);
  }

  function pressT9Digit(value: string) {
    const s = sessionRef.current;
    if (ascii) {
      s?.setOption("ascii_mode", false);
      if (s) cacheRimeMetadata({ ascii: false });
      setShifted(false);
      setCapsLocked(false);
    }
    clearT9ProcessorSelection();
    setT9CandidatePinyinFilter(null);
    let nextFilter: T9FilterState | null = null;
    if (/^[2-9]$/.test(value)) {
      const current = t9FilterStateRef.current.digits &&
          (currentPreedit().length === 0 ||
            !t9HasCommittedPrefix(currentPreedit()))
        ? t9FilterStateRef.current
        : t9FilterFromPreedit(currentPreedit());
      nextFilter = {
        digits: `${current.digits}${value}`,
        selected: current.selected,
      };
      setT9FilterState(nextFilter);
    }
    consumeSelectAllForReplacement();
    if (!s) return;
    processSessionKey(
      s,
      value.charCodeAt(0),
      undefined,
      { preserveT9FilterState: nextFilter != null },
      "t9Digit",
    );
    if (nextFilter != null && !s.context?.preedit) {
      setT9FilterState(nextFilter);
    }
  }

  function runT9PunctuationItem(item: T9PunctuationItem) {
    runConfiguredAction(item.action, item.mode);
  }

  function pressT9Delimiter() {
    const preedit = currentPreedit();
    if (ascii || preedit.length === 0) {
      insertTextReplacingSelectAll("'");
      return;
    }
    processText("'");
    setT9DelimiterVisualPositions((prev) => [...prev, preedit.length]);
  }

  function syncT9ProcessorSelection(selected: string[]) {
    const s = sessionRef.current;
    if (!s) return;
    const value = selected.filter(Boolean).join("'");
    try {
      s.setProperty("t9_processor_selected", value);
      s.setProperty("t9_processor_digits", t9FilterStateRef.current.digits);
      s.processKey(KEY_SPACE, MOD_CONTROL | MOD_SHIFT);
    } catch {}
    refresh(s, { suppressCommit: true, preserveT9FilterState: true });
  }

  function selectT9Pinyin(option: T9PinyinOption) {
    playReleaseFeedback();
    playPressFeedback(true);
    setT9DelimiterVisualPositions([]);
    setT9FilterState({
      digits: option.digits,
      selected: option.selected,
    });
    setT9CandidatePinyinFilter({
      selected: option.selected,
      preeditCore: t9PreeditCore(currentPreedit()),
    });
    syncT9ProcessorSelection(option.selected);
  }

  function commitComposition() {
    const s = sessionRef.current;
    if (!s) return;
    const result = s.commitComposition();
    if (result?.text) insertTextReplacingSelectAll(result.text);
    void s.commit;
    refresh(s);
  }

  async function pasteText() {
    try {
      const text = await Pasteboard.getString();
      if (text) insertTextReplacingSelectAll(text);
    } catch {}
  }

  async function copySelectedText() {
    try {
      if (CustomKeyboard.selectedText) {
        await Pasteboard.setString(CustomKeyboard.selectedText);
        clearSelectAllStateForExternalAction();
      }
    } catch {}
  }

  async function cutSelectedText() {
    try {
      if (!CustomKeyboard.selectedText) return;
      await Pasteboard.setString(CustomKeyboard.selectedText);
      clearSelectAllStateForExternalAction();
      CustomKeyboard.deleteBackward();
    } catch {}
  }

  function clearSelectAllState() {
    selectAllSnapshotRef.current = null;
    setSelectAllActive(false);
  }

  function clearSelectAllStateForExternalAction() {
    if (!selectAllActive && !selectAllSnapshotRef.current) return;
    clearSelectAllState();
  }

  function selectedTextSnapshot() {
    const before = CustomKeyboard.textBeforeCursor ?? "";
    const after = CustomKeyboard.textAfterCursor ?? "";
    const joined = `${before}${after}`;
    return joined || CustomKeyboard.allText || "";
  }

  function deleteDeletableTextAroundCursor(): string {
    const text = selectedTextSnapshot();
    if (!text) return "";
    const before = CustomKeyboard.textBeforeCursor ?? "";
    const after = CustomKeyboard.textAfterCursor ?? "";
    const deleteCount = before.length + after.length || text.length;
    if (after.length > 0) CustomKeyboard.moveCursor(after.length);
    for (let i = 0; i < deleteCount; i += 1) CustomKeyboard.deleteBackward();
    return text;
  }

  function consumeSelectAllForReplacement() {
    if (!selectAllActive && !selectAllSnapshotRef.current) return;
    try {
      if (CustomKeyboard.selectedText) {
        CustomKeyboard.deleteBackward();
      } else {
        try {
          CustomKeyboard.setMarkedText("", 0, 0);
          CustomKeyboard.unmarkText();
        } catch {}
        deleteDeletableTextAroundCursor();
      }
    } catch {}
    clearSelectAllState();
  }

  function consumeSelectAllForDeletion() {
    if (!selectAllActive && !selectAllSnapshotRef.current) return false;
    const selected = CustomKeyboard.selectedText;
    if (selected) {
      deletedTextRef.current = selected;
      try {
        CustomKeyboard.deleteBackward();
      } catch {}
      clearSelectAllState();
      return true;
    }
    const deleted = deleteDeletableTextAroundCursor() ||
      selectAllSnapshotRef.current?.text ||
      "";
    if (deleted) deletedTextRef.current = deleted;
    clearSelectAllState();
    return true;
  }

  function insertTextReplacingSelectAll(text: string) {
    if (!text) return;
    consumeSelectAllForReplacement();
    CustomKeyboard.insertText(text);
  }

  function textSnapshot() {
    return CustomKeyboard.allText || selectedTextSnapshot();
  }

  function selectAllBestEffort() {
    try {
      const text = textSnapshot();
      if (!text) {
        clearSelectAllState();
        return false;
      }
      selectAllSnapshotRef.current = {
        text,
        cursorBefore: CustomKeyboard.textBeforeCursor?.length ?? 0,
      };

      const keyboard = CustomKeyboard as any;
      if (typeof keyboard.selectAll === "function") {
        keyboard.selectAll();
        setSelectAllActive(true);
        return true;
      }
      if (typeof keyboard.setSelectionRange === "function") {
        keyboard.setSelectionRange(0, CustomKeyboard.allText?.length ?? 0);
        setSelectAllActive(true);
        return true;
      }
      if (typeof keyboard.selectText === "function") {
        keyboard.selectText(0, CustomKeyboard.allText?.length ?? 0);
        setSelectAllActive(true);
        return true;
      }

      const after = CustomKeyboard.textAfterCursor?.length ?? 0;
      if (after > 0) moveCursorSafely(after, true);
      for (let i = 0; i < text.length; i += 1) {
        CustomKeyboard.deleteBackward();
      }
      CustomKeyboard.setMarkedText(text, 0, text.length);
      setSelectAllActive(true);
      return true;
    } catch {}
    clearSelectAllState();
    return false;
  }

  function cancelSelectAllBestEffort() {
    try {
      const snapshot = selectAllSnapshotRef.current;
      if (!snapshot) {
        clearSelectAllState();
        return;
      }
      if (CustomKeyboard.selectedText === snapshot.text) {
        CustomKeyboard.insertText(snapshot.text);
        const cursorFromEnd = snapshot.text.length - snapshot.cursorBefore;
        if (cursorFromEnd !== 0) moveCursorSafely(-cursorFromEnd, true);
      } else {
        try {
          CustomKeyboard.unmarkText();
        } catch {}
      }
    } catch {}
    clearSelectAllState();
  }

  function toggleSelectAll() {
    if (selectAllActive) {
      cancelSelectAllBestEffort();
    } else {
      selectAllBestEffort();
    }
  }

  function clearSelectAllForCursorMove(offset = 0) {
    if (!selectAllActive && !selectAllSnapshotRef.current) return false;
    try {
      const snapshot = selectAllSnapshotRef.current;
      if (snapshot) {
        CustomKeyboard.insertText(snapshot.text);
        if (offset < 0) {
          CustomKeyboard.moveCursor(-snapshot.text.length);
        }
      } else {
        try {
          CustomKeyboard.unmarkText();
        } catch {}
      }
    } catch {}
    clearSelectAllState();
    return true;
  }

  function moveCursorSafely(offset: number, force = false) {
    if (!force && clearSelectAllForCursorMove(offset)) return false;
    CustomKeyboard.moveCursor(offset);
    return true;
  }

  function deleteAllText() {
    stopRepeatingBackspace();
    try {
      if (selectAllActive || selectAllSnapshotRef.current) {
        consumeSelectAllForDeletion();
        return;
      }
      if (CustomKeyboard.selectedText) {
        deletedTextRef.current = CustomKeyboard.selectedText;
        CustomKeyboard.deleteBackward();
        clearSelectAllState();
        return;
      }
      const text = selectedTextSnapshot();
      if (!text) {
        clearSelectAllStateForExternalAction();
        return;
      }
      clearSelectAllStateForExternalAction();
      deletedTextRef.current = text;
      deleteDeletableTextAroundCursor();
    } catch {}
  }

  function restoreDeletedText() {
    stopRepeatingBackspace();
    if (!deletedTextRef.current) return;
    insertTextReplacingSelectAll(deletedTextRef.current);
  }

  function runConfiguredAction(action: string, mode: ActionSendMode = "auto") {
    if (!action) return;
    if (mode === "direct") {
      insertConfiguredText(action);
      return;
    }
    if (mode === "rime") {
      processTextThroughRime(action);
      return;
    }
    switch (action) {
      case "":
        return;
      case "{left}":
        moveCursorSafely(-1);
        return;
      case "{right}":
        moveCursorSafely(1);
        return;
      case "{home}":
        if (clearSelectAllForCursorMove(-1)) return;
        CustomKeyboard.moveCursor(
          -(CustomKeyboard.textBeforeCursor?.length ?? 0),
        );
        return;
      case "{end}":
        if (clearSelectAllForCursorMove(1)) return;
        CustomKeyboard.moveCursor(CustomKeyboard.textAfterCursor?.length ?? 0);
        return;
      case "{selectAll}":
        selectAllBestEffort();
        return;
      case "{toggleSelectAll}":
        toggleSelectAll();
        return;
      case "{cut}":
        void cutSelectedText();
        return;
      case "{copy}":
        void copySelectedText();
        return;
      case "{paste}":
        void pasteText();
        return;
      case "{rimeUp}":
        processKey(KEY_UP);
        return;
      case "{rimeDown}":
        processKey(KEY_DOWN);
        return;
      case "{rimePageUp}":
        processKey(KEY_PAGE_UP);
        return;
      case "{rimePageDown}":
        processKey(KEY_PAGE_DOWN);
        return;
      case "{deleteAll}":
        deleteAllText();
        return;
      case "{restoreDeleted}":
        restoreDeletedText();
        return;
      case "{clearComposition}":
        clearComposition();
        return;
      case "{commitComposition}":
        commitComposition();
        return;
      case "{toggleSymbol}":
        toggleSymbolLayer();
        return;
      case "{newline}":
        Thread.runInMain(() => insertTextReplacingSelectAll("\n"));
        return;
      case "{translate}":
        void runToolbarTranslate();
        return;
      case "{aiReply}":
        void runToolbarAIReply();
        return;
      case "{punctPanel}":
        if (currentPreedit()) clearComposition();
        setPunctPanelOpen(true);
        return;
      case "{togglePunct}":
        togglePunct();
        return;
      case "{chinesePunct}":
        setAsciiPunct(false);
        return;
      case "{englishPunct}":
        setAsciiPunct(true);
        return;
      case "{backslash}":
      case "backslash":
      case "\\":
        processText("\\");
        return;
      default:
        if (processRimeKeySpec(action)) return;
        processTextThroughRime(action);
    }
  }

  function runLetterSwipe(direction: "up" | "down", key: string) {
    const actions = direction === "up"
      ? settings.letterSwipeUp
      : settings.letterSwipeDown;
    const modes = direction === "up"
      ? settings.letterSwipeUpModes
      : settings.letterSwipeDownModes;
    const action = actions[key];
    runConfiguredAction(action, modes[key]);
  }

  function runIdleFunctionSwipe(direction: "up" | "down", key: string) {
    const actions = direction === "up"
      ? settings.idleFunctionSwipeUp
      : settings.idleFunctionSwipeDown;
    const modes = direction === "up"
      ? settings.idleFunctionSwipeUpModes
      : settings.idleFunctionSwipeDownModes;
    runConfiguredAction(actions[key], modes[key]);
  }

  function runIdleFunctionPress(key: string) {
    runConfiguredAction(
      settings.idleFunctionPress[key],
      settings.idleFunctionPressModes[key],
    );
  }

  function runComposingFunctionSwipe(direction: "up" | "down", key: string) {
    const actions = direction === "up"
      ? settings.composingFunctionSwipeUp
      : settings.composingFunctionSwipeDown;
    const modes = direction === "up"
      ? settings.composingFunctionSwipeUpModes
      : settings.composingFunctionSwipeDownModes;
    runConfiguredAction(actions[key], modes[key]);
  }

  function runComposingFunctionPress(key: string) {
    const action = settings.composingFunctionPress[key];
    const mode = settings.composingFunctionPressModes[key];
    runConfiguredAction(action, mode);
    if (
      key === "filter" &&
      action.trim().length > 0 &&
      settings.composingFunctionWrapDisplayEnabled
    ) {
      setBackslashWrapMode(true);
    }
  }

  function runCandidateMenuAction(absoluteIndex: number, action: string) {
    if (!highlightCandidateAbsolute(absoluteIndex)) return;
    runConfiguredAction(action, "rime");
    if (candidateExpanded) collectExpandedCandidateBatch();
  }

  function openRimeSchemaMenu() {
    suppressSchemaMenuInlineRef.current = true;
    processKeyWithModifiers("`".charCodeAt(0), MOD_CONTROL, {
      suppressCommit: true,
      suppressInlineMarkedText: true,
    });
  }

  function candidateComment(candidate: Rime.Candidate): string {
    return settings.showCandidateComment
      ? (candidate.comment?.trim() ?? "")
      : "";
  }

  const t9LocalComposing = isT9Keyboard &&
    (t9Preedit.length > 0 || t9FilterState.digits.length > 0);
  const composing = rimeComposing || t9LocalComposing;
  const t9PinyinOptions = t9LocalComposing
    ? t9PinyinOptionsFromPreedit(
      t9Preedit,
      t9FilterState,
      t9CandidatePinyinFilter,
    )
    : [];
  const usesComposingFunctionRow = composing && !symbolLayer &&
    settings.composingFunctionRowEnabled;
  const usesT9MixedFunctionRow = usesComposingFunctionRow && isT9Keyboard;
  const schemaMenu = useMemo(
    () =>
      schemas.length > 1
        ? (
          <Group>
            {schemas.map((schema) => (
              <Button
                key={schema.id}
                title={`${
                  schema.id === currentSchemaId ? "✓ " : ""
                }${schema.name}${
                  schema.name === schema.id ? "" : ` (${schema.id})`
                }`}
                action={() => switchSchema(schema.id)}
              />
            ))}
          </Group>
        )
        : null,
    [currentSchemaId, schemas],
  );
  const candidateMenuActions = useMemo(
    () =>
      (settings.candidateMenuCustomEnabled
        ? settings.candidateMenuActions
        : DEFAULT_CANDIDATE_MENU_ACTIONS).filter((item) =>
          item.name.trim().length > 0 && item.action.trim().length > 0
        ),
    [settings.candidateMenuCustomEnabled, settings.candidateMenuActions],
  );
  const localT9PreeditDisplay = isT9Keyboard
    ? t9LocalPreeditDisplay(
      t9Preedit,
      t9FilterState,
      t9CandidatePinyinFilter,
    )
    : null;
  const keyboardPreedit = isT9Keyboard
    ? withT9VisualDelimiters(
      localT9PreeditDisplay ?? t9Preedit,
      localT9PreeditDisplay ? [] : t9DelimiterVisualPositions,
    )
    : "";
  const safePreeditCursor = Math.min(
    keyboardPreedit.length,
    Math.max(
      0,
      localT9PreeditDisplay ? keyboardPreedit.length : t9PreeditCursor +
        (isT9Keyboard
          ? t9VisualDelimiterOffset(
            t9PreeditCursor,
            t9DelimiterVisualPositions,
          )
          : 0),
    ),
  );
  const showNextKeyboardButton = useMemo(() => Device.isiPad, []);
  const bodyRowSpacing = 6;
  const visibleBodyRowCount = (settings.showFunctionRow ? 1 : 0) + 4;
  const normalKeyboardBodyHeight =
    (settings.showFunctionRow
      ? metrics.functionKeyHeight + bodyRowSpacing
      : 0) +
    metrics.keyHeight * 4 +
    bodyRowSpacing * 3;
  const numericRowSpacing = 6;
  const numericPanelHeight = metrics.keyHeight * 4 + numericRowSpacing * 3;
  const numericLeftWidth = Math.max(40, Math.min(56, metrics.width * 0.14));
  const numericRightWidth = Math.max(48, Math.min(72, metrics.width * 0.18));
  const numericCenterWidth = metrics.width - numericLeftWidth -
    numericRightWidth - KEY_SPACING * 2;
  const numericKeyWidth = (numericCenterWidth - KEY_SPACING * 2) / 3;
  const numericPanelTopInset = settings.showFunctionRow
    ? bodyRowSpacing / 2
    : 0;
  const {
    panelHeight: t9PanelHeight,
    panelTopInset: t9PanelTopInset,
    panelBottomInset: t9PanelBottomInset,
    leftWidth: t9LeftWidth,
    rightWidth: t9RightWidth,
    centerWidth: t9CenterWidth,
    keyWidth: t9KeyWidth,
  } = useMemo(() => {
    if (!isT9Keyboard) {
      return {
        panelHeight: 0,
        panelTopInset: 0,
        panelBottomInset: 0,
        leftWidth: 0,
        rightWidth: 0,
        centerWidth: 0,
        keyWidth: 0,
      };
    }
    const leftWidth = Math.max(42, Math.min(58, metrics.width * 0.15));
    const rightWidth = Math.max(48, Math.min(70, metrics.width * 0.17));
    const centerWidth = metrics.width - leftWidth - rightWidth -
      KEY_SPACING * 2;
    return {
      panelHeight: metrics.keyHeight * 3 + numericRowSpacing * 2,
      panelTopInset: settings.showFunctionRow ? bodyRowSpacing / 2 : 0,
      panelBottomInset: bodyRowSpacing / 2,
      leftWidth,
      rightWidth,
      centerWidth,
      keyWidth: (centerWidth - KEY_SPACING * 2) / 3,
    };
  }, [
    isT9Keyboard,
    metrics.keyHeight,
    metrics.width,
    settings.showFunctionRow,
  ]);
  const bottomNumbersWidth = isT9Keyboard
    ? t9LeftWidth
    : metrics.bottom.numbers;
  const bottomCommaWidth = metrics.bottom.comma;
  const bottomModeWidth = metrics.bottom.mode;
  const bottomEnterWidth = isT9Keyboard ? t9RightWidth : metrics.bottom.enter;
  const bottomSpaceWidth = isT9Keyboard
    ? Math.max(
      44,
      metrics.width - bottomNumbersWidth - bottomCommaWidth -
        bottomModeWidth - bottomEnterWidth - KEY_SPACING * 4,
    )
    : metrics.bottom.space;
  const bottomSplitButtonWidth = Math.max(
    20,
    (bottomNumbersWidth - KEY_SPACING) / 2,
  );

  const expandedPanelHeight = normalKeyboardBodyHeight;

  function shiftSwipeUp() {
    if (composing && settings.shiftComposingEnabled) {
      runConfiguredAction(
        settings.shiftComposingSwipeUp,
        settings.shiftComposingSwipeUpMode,
      );
    } else {
      processText("'");
    }
  }

  function composingFunctionViewId(key: string) {
    switch (key) {
      case "page":
        return "func-page-down";
      case "tone1":
        return "tone-1";
      case "tone2":
        return "tone-2";
      case "tone3":
        return "tone-3";
      case "tone4":
        return "tone-4";
      case "filter":
        return "func-backslash";
      default:
        return `func-${key}`;
    }
  }

  function idleFunctionViewId(key: string) {
    return key === "select" ? "idle-schema" : `idle-${key}`;
  }

  function composingFunctionHitTargets(): KeyHitTarget[] {
    const step = metrics.functionWidth8 + KEY_SPACING;
    const frame = (index: number) =>
      horizontalHitFrame(step * index, metrics.functionWidth8, index, 8);
    return settings.composingFunctionOrder.map((key, index) => ({
      id: composingFunctionViewId(key),
      ...frame(index),
      onPress: () => hitTargetActionsRef.current.runComposingFunctionPress(key),
      onSwipeUp: () =>
        hitTargetActionsRef.current.runComposingFunctionSwipe("up", key),
      onSwipeDown: () =>
        hitTargetActionsRef.current.runComposingFunctionSwipe("down", key),
    }));
  }

  function t9MixedFunctionHitTargets(): KeyHitTarget[] {
    const step = metrics.functionWidth8 + KEY_SPACING;
    const frame = (index: number) =>
      horizontalHitFrame(step * index, metrics.functionWidth8, index, 8);
    return settings.composingFunctionOrder.map((key, index) => {
      const useIdle = index >= 2 && index <= 6;
      const actionKey = useIdle ? settings.idleFunctionOrder[index] : key;
      return {
        id: useIdle
          ? idleFunctionViewId(actionKey)
          : composingFunctionViewId(actionKey),
        ...frame(index),
        onPress: () =>
          useIdle
            ? hitTargetActionsRef.current.runIdleFunctionPress(actionKey)
            : hitTargetActionsRef.current.runComposingFunctionPress(actionKey),
        onSwipeUp: () =>
          useIdle
            ? hitTargetActionsRef.current.runIdleFunctionSwipe("up", actionKey)
            : hitTargetActionsRef.current.runComposingFunctionSwipe(
              "up",
              actionKey,
            ),
        onSwipeDown: () =>
          useIdle
            ? hitTargetActionsRef.current.runIdleFunctionSwipe(
              "down",
              actionKey,
            )
            : hitTargetActionsRef.current.runComposingFunctionSwipe(
              "down",
              actionKey,
            ),
      };
    });
  }

  function idleFunctionHitTargets(): KeyHitTarget[] {
    const step = metrics.functionWidth8 + KEY_SPACING;
    const frame = (index: number) =>
      horizontalHitFrame(step * index, metrics.functionWidth8, index, 8);
    return settings.idleFunctionOrder.map((key, index) => {
      const pressAction = settings.idleFunctionPress[key];
      const isCursorLeft = key === "left" && pressAction === "{left}";
      const isCursorRight = key === "right" && pressAction === "{right}";
      const isCursorRepeat = isCursorLeft || isCursorRight;
      return {
        id: idleFunctionViewId(key),
        ...frame(index),
        onPress: () => hitTargetActionsRef.current.runIdleFunctionPress(key),
        onLongPress: isCursorLeft
          ? () => hitTargetActionsRef.current.startRepeatingCursorMove(-1)
          : isCursorRight
          ? () => hitTargetActionsRef.current.startRepeatingCursorMove(1)
          : undefined,
        onLongPressEnd: isCursorRepeat
          ? () => hitTargetActionsRef.current.stopRepeatingCursorMove()
          : undefined,
        longPressDuration: isCursorRepeat
          ? CURSOR_REPEAT_DURATION
          : undefined,
        onSwipeUp: () =>
          hitTargetActionsRef.current.runIdleFunctionSwipe("up", key),
        onSwipeDown: () =>
          hitTargetActionsRef.current.runIdleFunctionSwipe("down", key),
      };
    });
  }

  function renderComposingFunctionKey(key: string) {
    const id = composingFunctionViewId(key);
    const isTone = key === "tone1" || key === "tone2" || key === "tone3" ||
      key === "tone4";
    return (
      <KeyFace
        key={`comp-func-${key}`}
        id={id}
        image={settings.composingFunctionSymbols[key]}
        imageScale={isTone ? "medium" : undefined}
        palette={palette}
        width={metrics.functionWidth8}
        height={metrics.functionKeyHeight}
        touchHeight={functionRowTouch.touchHeight}
        visualOffsetY={functionRowTouch.visualOffsetY}
        system
        passive
        active={isPressed(id)}
        onPress={() =>
          hitTargetActionsRef.current.runWithFeedback(() =>
            hitTargetActionsRef.current.runComposingFunctionPress(key)
          )}
        onSwipeUp={() =>
          hitTargetActionsRef.current.runWithFeedback(() =>
            hitTargetActionsRef.current.runComposingFunctionSwipe("up", key)
          )}
        onSwipeDown={() =>
          hitTargetActionsRef.current.runWithFeedback(() =>
            hitTargetActionsRef.current.runComposingFunctionSwipe("down", key)
          )}
      />
    );
  }

  function renderIdleFunctionKey(key: string) {
    const id = idleFunctionViewId(key);
    const pressAction = settings.idleFunctionPress[key];
    const isPunctToggle = pressAction === "{togglePunct}";
    const isPunctPanel = pressAction === "{punctPanel}";
    const isPunctKey = isPunctToggle || isPunctPanel;
    const symbol = key === "select" && selectAllActive &&
        settings.idleFunctionSymbols.select === "selection.pin.in.out"
      ? "xmark.circle"
      : settings.idleFunctionSymbols[key];
    const isCursorLeft = key === "left" && pressAction === "{left}";
    const isCursorRight = key === "right" && pressAction === "{right}";
    const isCursorRepeat = isCursorLeft || isCursorRight;
    return (
      <KeyFace
        key={`idle-func-${key}`}
        id={id}
        image={isPunctKey ? undefined : symbol}
        label={isPunctPanel
        ? "，。"
        : isPunctToggle
        ? (asciiPunctOn ? "," : "，")
        : undefined}
        labelFontSize={isPunctKey ? 20 : undefined}
        palette={palette}
        width={metrics.functionWidth8}
        height={metrics.functionKeyHeight}
        touchHeight={functionRowTouch.touchHeight}
        visualOffsetY={functionRowTouch.visualOffsetY}
        system
        passive
        active={isPressed(id)}
        selected={isPunctToggle
        ? asciiPunctOn
        : key === "select" && selectAllActive}
        onPress={() =>
          hitTargetActionsRef.current.runWithFeedback(() =>
            hitTargetActionsRef.current.runIdleFunctionPress(key)
          )}
        onLongPress={isCursorLeft
          ? () => hitTargetActionsRef.current.startRepeatingCursorMove(-1)
          : isCursorRight
          ? () => hitTargetActionsRef.current.startRepeatingCursorMove(1)
          : undefined}
        onLongPressEnd={isCursorRepeat
          ? () => hitTargetActionsRef.current.stopRepeatingCursorMove()
          : undefined}
        longPressDuration={isCursorRepeat
          ? CURSOR_REPEAT_DURATION
          : undefined}
        onSwipeUp={() =>
          hitTargetActionsRef.current.runWithFeedback(() =>
            hitTargetActionsRef.current.runIdleFunctionSwipe("up", key)
          )}
        onSwipeDown={() =>
          hitTargetActionsRef.current.runWithFeedback(() =>
            hitTargetActionsRef.current.runIdleFunctionSwipe("down", key)
          )}
      />
    );
  }

  function renderT9MixedFunctionKey(key: string, index: number) {
    return index >= 2 && index <= 6
      ? renderIdleFunctionKey(settings.idleFunctionOrder[index])
      : renderComposingFunctionKey(key);
  }

  function bottomRowHitTargets(): KeyHitTarget[] {
    let x = 0;
    const targets: KeyHitTarget[] = [];
    if (showNextKeyboardButton) {
      targets.push({
        id: "next-keyboard",
        x,
        width: bottomSplitButtonWidth,
        onPress: () => hitTargetActionsRef.current.nextKeyboard(),
      });
      x += bottomSplitButtonWidth + KEY_SPACING;
      targets.push({
        id: "numbers",
        x,
        width: bottomSplitButtonWidth,
        onPress: () => hitTargetActionsRef.current.toggleSymbolLayer(),
        onSwipeUp: () => hitTargetActionsRef.current.pressBacktick(),
      });
      x += bottomSplitButtonWidth + KEY_SPACING;
    } else {
      targets.push({
        id: "numbers",
        x,
        width: bottomNumbersWidth,
        onPress: () => hitTargetActionsRef.current.toggleSymbolLayer(),
        onSwipeUp: () => hitTargetActionsRef.current.pressBacktick(),
      });
      x += bottomNumbersWidth + KEY_SPACING;
    }
    targets.push({
      id: "comma",
      x,
      width: bottomCommaWidth,
      onPress: () => hitTargetActionsRef.current.pressComma(),
      onSwipeUp: () => hitTargetActionsRef.current.pressPeriod(),
    });
    x += bottomCommaWidth + KEY_SPACING;
    targets.push({
      id: "space",
      x,
      width: bottomSpaceWidth,
      onPress: () => hitTargetActionsRef.current.pressSpace(),
      onLongPress: () => {
        spaceCursorDragXRef.current = null;
      },
      onLongPressEnd: () => {
        spaceCursorDragXRef.current = null;
      },
      onSwipeUp: isT9Keyboard
        ? () => hitTargetActionsRef.current.runT9SpaceSwipe("up")
        : canSpaceSwipeCandidate("2")
        ? () => hitTargetActionsRef.current.processSpaceSwipeCandidate("2")
        : undefined,
      onSwipeDown: isT9Keyboard
        ? () => hitTargetActionsRef.current.runT9SpaceSwipe("down")
        : canSpaceSwipeCandidate("3")
        ? () => hitTargetActionsRef.current.processSpaceSwipeCandidate("3")
        : undefined,
      onSwipeLeft: () => hitTargetActionsRef.current.moveCursorSafely(-1),
      onSwipeRight: () => hitTargetActionsRef.current.moveCursorSafely(1),
    });
    x += bottomSpaceWidth + KEY_SPACING;
    targets.push({
      id: "mode",
      x,
      width: bottomModeWidth,
      safetyReleaseDelay: 180,
      onPress: () => {
        hitTargetActionsRef.current.pressMode();
      },
      onSwipeUp: composing && settings.modeComposingEnabled
        ? () => hitTargetActionsRef.current.modeSwipeUp()
        : undefined,
      onSwipeDown: composing && settings.modeComposingEnabled
        ? () => hitTargetActionsRef.current.modeSwipeDown()
        : undefined,
    });
    x += bottomModeWidth + KEY_SPACING;
    if (!isT9Keyboard) {
      targets.push({
        id: "enter",
        x,
        width: bottomEnterWidth,
        onPress: () => hitTargetActionsRef.current.pressReturn(),
        onSwipeUp: () => hitTargetActionsRef.current.insertNewline(),
      });
    }
    return targets.map((target, index) => ({
      ...target,
      ...horizontalHitFrame(target.x, target.width, index, targets.length),
    }));
  }

  function numericRowHitTargets(row: string[]): KeyHitTarget[] {
    return row.map((value, index) => {
      const displayX = index * (numericKeyWidth + KEY_SPACING);
      return {
        id: value === "ABC"
          ? "numeric-abc"
          : value === "space"
          ? "numeric-space"
          : `numeric-${value}`,
        ...horizontalHitFrame(displayX, numericKeyWidth, index, row.length),
        onPress: () => {
          if (value === "ABC") {
            hitTargetActionsRef.current.switchToLetterLayer();
          } else if (value === "space") {
            hitTargetActionsRef.current.pressSpace();
          } else hitTargetActionsRef.current.pressNumericDigit(value);
        },
        onLongPress: value === "space"
          ? () => {
            spaceCursorDragXRef.current = null;
          }
          : undefined,
        onLongPressEnd: value === "space"
          ? () => {
            spaceCursorDragXRef.current = null;
          }
          : undefined,
        onSwipeUp: value === "space" && canSpaceSwipeCandidate("2")
          ? () => hitTargetActionsRef.current.processSpaceSwipeCandidate("2")
          : undefined,
        onSwipeDown: value === "space" && canSpaceSwipeCandidate("3")
          ? () => hitTargetActionsRef.current.processSpaceSwipeCandidate("3")
          : undefined,
        onSwipeLeft: value === "space"
          ? () => hitTargetActionsRef.current.moveCursorSafely(-1)
          : undefined,
        onSwipeRight: value === "space"
          ? () => hitTargetActionsRef.current.moveCursorSafely(1)
          : undefined,
      };
    });
  }

  function numericRightHitTargets(): KeyHitTarget[] {
    const frame = (index: number) =>
      verticalHitFrame(
        (metrics.keyHeight + numericRowSpacing) * index,
        metrics.keyHeight,
        index,
        4,
        numericRowSpacing,
      );
    return [
      {
        id: "numeric-backspace",
        x: 0,
        width: numericRightWidth,
        ...frame(0),
        onPress: () => hitTargetActionsRef.current.pressBackspace(),
        onLongPress: () =>
          hitTargetActionsRef.current.startRepeatingBackspace(
            "numeric-backspace",
          ),
        onLongPressEnd: () =>
          hitTargetActionsRef.current.stopRepeatingBackspace(),
        longPressDuration: DELETE_LONG_PRESS_DURATION,
        onSwipeLeft: () => hitTargetActionsRef.current.backspaceSwipeLeft(),
        onSwipeUp: () => hitTargetActionsRef.current.backspaceSwipeUp(),
        onSwipeDown: () => hitTargetActionsRef.current.backspaceSwipeDown(),
      },
      {
        id: "numeric-dot",
        x: 0,
        width: numericRightWidth,
        ...frame(1),
        onPress: () => hitTargetActionsRef.current.pressNumericDot(),
      },
      {
        id: "numeric-equal",
        x: 0,
        width: numericRightWidth,
        ...frame(2),
        onPress: () => hitTargetActionsRef.current.pressEqual(),
        onSwipeUp: () => hitTargetActionsRef.current.numericEqualSwipeUp(),
      },
      {
        id: "numeric-enter",
        x: 0,
        width: numericRightWidth,
        ...frame(3),
        onPress: () => hitTargetActionsRef.current.pressReturn(),
        onSwipeUp: () => hitTargetActionsRef.current.insertNewline(),
      },
    ];
  }

  function collectExpandedCandidateBatch(session = sessionRef.current) {
    const menu = session?.context?.menu;
    if (!session || !menu) {
      setExpandedCandidates([]);
      setExpandedBatchHasMore(false);
      return;
    }

    const originalPage = menu.pageNo;
    const items: ExpandedCandidateItem[] = [];
    let hasMore = false;

    for (let page = 0; page < EXPANDED_RIME_PAGE_BATCH; page += 1) {
      const currentMenu = session.context?.menu;
      if (!currentMenu) break;
      currentMenu.candidates.forEach((candidate, index) => {
        items.push({
          candidate,
          absoluteIndex: currentMenu.pageNo * currentMenu.pageSize + index,
        });
      });
      if (currentMenu.isLastPage) break;
      if (page === EXPANDED_RIME_PAGE_BATCH - 1) {
        hasMore = true;
        break;
      }
      if (!session.processKey(KEY_PAGE_DOWN)) break;
    }

    const currentPage = session.context?.menu?.pageNo ?? originalPage;
    for (let page = currentPage; page > originalPage; page -= 1) {
      session.processKey(KEY_PAGE_UP);
    }

    setExpandedCandidates(items);
    setExpandedBatchHasMore(hasMore);
    refresh(session);
  }

  function moveExpandedCandidateBatch(direction: "up" | "down") {
    const s = sessionRef.current;
    if (!s) return;
    stopRepeatingBackspace();
    stopRepeatingCursorMove();
    clearAllRowGestureState();
    releaseAllPressedKeys();

    if (direction === "up") {
      const menu = s.context?.menu;
      const steps = Math.min(EXPANDED_RIME_PAGE_BATCH, menu?.pageNo ?? 0);
      for (let i = 0; i < steps; i += 1) {
        s.processKey(KEY_PAGE_UP);
      }
    } else {
      for (let i = 0; i < EXPANDED_RIME_PAGE_BATCH; i += 1) {
        const menu = s.context?.menu;
        if (!menu || menu.isLastPage) break;
        if (!s.processKey(KEY_PAGE_DOWN)) break;
      }
    }
    collectExpandedCandidateBatch(s);
  }

  function pressCandidateRightButton() {
    stopRepeatingBackspace();
    stopRepeatingCursorMove();
    clearAllRowGestureState();
    releaseAllPressedKeys();
    const effectiveCandidateRightButtonMode =
      settings.candidateRightButtonMode === "expand" &&
        currentCandidates().length === 0
        ? "dismiss"
        : settings.candidateRightButtonMode;
    if (effectiveCandidateRightButtonMode === "expand") {
      if (candidateExpanded) {
        setCandidateExpanded(false);
        setExpandedCandidates([]);
        setExpandedBatchHasMore(false);
      } else {
        collectExpandedCandidateBatch();
        setCandidateExpanded(true);
      }
    } else if (effectiveCandidateRightButtonMode === "dismiss") {
      CustomKeyboard.dismiss();
    }
  }

  function pressCandidateHomeButton() {
    CustomKeyboard.dismissToHome();
  }

  function pressCandidateSettingsButton() {
    const url = Script.createRunSingleURLScheme(Script.name, {
      source: "keyboard-settings",
    });
    try {
      CustomKeyboard.dismiss();
    } catch {}
    setTimeout(() => {
      void Safari.openURL(url);
    }, 80);
  }

  function runToolbarScript(scriptName: string) {
    const targetName = scriptName.trim() || Script.name;
    const url = Script.createRunSingleURLScheme(targetName, {
      source: "keyboard-toolbar",
    });
    try {
      CustomKeyboard.dismiss();
    } catch {}
    setTimeout(() => {
      void Safari.openURL(url);
    }, 80);
  }

  function openToolbarURL(value: string) {
    const url = value.trim();
    if (!url) return;
    try {
      CustomKeyboard.dismiss();
    } catch {}
    setTimeout(() => {
      void Safari.openURL(url);
    }, 80);
  }

  function switchKeyboardScript(scriptName: string) {
    const targetName = scriptName.trim();
    if (!targetName) return;
    const target = CustomKeyboard.allScripts?.find((script) =>
      script.name === targetName || script.localizedName === targetName
    );
    void CustomKeyboard.switchToScript(target?.name ?? targetName).catch(() => {
      try {
        CustomKeyboard.dismissToHome();
      } catch {}
    });
  }

  async function readToolbarClipboard() {
    try {
      return await Pasteboard.getString() ?? "";
    } catch (error) {
      console.error(
        "[Scripting Rime Keyboard] Failed to read clipboard",
        error,
      );
      return "";
    }
  }

  function expandToolbarScriptTemplate(source: string, clipboard: string) {
    if (
      !source.includes(TOOLBAR_TEMPLATE_CLIPBOARD) &&
      !source.includes(LEGACY_TOOLBAR_TEMPLATE_CLIPBOARD)
    ) {
      return source;
    }
    return source.replaceAll(
      TOOLBAR_TEMPLATE_CLIPBOARD,
      JSON.stringify(clipboard),
    ).replaceAll(
      LEGACY_TOOLBAR_TEMPLATE_CLIPBOARD,
      JSON.stringify(clipboard),
    );
  }

  function toolbarScriptContext(clipboard: string) {
    const state = rimeStateRef.current;
    return {
      clipboard,
      preedit: state.preedit,
      candidates: state.candidates.map((candidate) => ({
        text: candidate.text,
        comment: candidateComment(candidate),
      })),
      openURL: openToolbarURL,
      runScript: runToolbarScript,
      switchKeyboard: switchKeyboardScript,
      dismissKeyboard: () => CustomKeyboard.dismiss(),
      keyboardHome: pressCandidateHomeButton,
      runAction: runToolbarAction,
      // 取词能力（js 沙箱无 CustomKeyboard/Storage，必须经 ctx 代理）。
      selectedText: () => CustomKeyboard.selectedText ?? "",
      textBeforeCursor: () => CustomKeyboard.textBeforeCursor ?? "",
      textAfterCursor: () => CustomKeyboard.textAfterCursor ?? "",
      allText: () => CustomKeyboard.allText ?? "",
      // 读源文本：选中 → 光标前 → 剪贴板兜底。
      readField: () => {
        const selected = CustomKeyboard.selectedText ?? "";
        if (selected.trim()) return selected;
        const before = CustomKeyboard.textBeforeCursor ?? "";
        if (before.trim()) return before;
        return clipboard ?? "";
      },
      // 代理读取激活的 AI 模型；键盘仅支持 ai_api（可直接 fetch），否则返回 null。
      activeAIModel: () => {
        const entry = getActiveModel();
        if (!entry || !isModelUsableInKeyboard(entry)) return null;
        return {
          id: entry.id,
          label: modelEntryLabel(entry),
          baseUrl: entry.baseUrl ?? "",
          apiKey: entry.apiKey ?? "",
          model: entry.model ?? "",
          compatibilityMode: entry.compatibilityMode ?? "custom",
        };
      },
      insertText: (text: unknown) => {
        const value = String(text ?? "");
        if (!value) return;
        Thread.runInMain(() => insertTextReplacingSelectAll(value));
      },
    };
  }

  async function runToolbarInlineScript(source: string) {
    const clipboard = await readToolbarClipboard();
    const script = expandToolbarScriptTemplate(source, clipboard);
    try {
      const run = new ToolbarScriptFunction(
        "ctx",
        "fetch",
        "console",
        `"use strict";\nreturn (async () => {\n${script}\n})();`,
      );
      await run(toolbarScriptContext(clipboard), fetch, console);
      showRimeNotificationToast("JS执行成功");
    } catch (error) {
      console.error("[Scripting Rime Keyboard] Toolbar JS failed", error);
      const message = error instanceof Error && error.message
        ? `${error.name}: ${error.message}`
        : String(error);
      showRimeNotificationToast(
        `JS错误：${message.replace(/\s+/g, " ").slice(0, 160)}`,
      );
    }
  }

  function runToolbarAction(action: string) {
    const value = action.trim();
    if (!value) return;
    if (value === "{keyboardHome}") {
      pressCandidateHomeButton();
      return;
    }
    if (value === "{keyboardSettings}") {
      pressCandidateSettingsButton();
      return;
    }
    if (value === "{schemaMenu}") {
      openRimeSchemaMenu();
      return;
    }
    if (value === "{newline}") {
      Thread.runInMain(() => insertTextReplacingSelectAll("\n"));
      return;
    }
    if (value === "{modelMenu}") {
      setModelSearchQuery("");
      setModelPickerOpen(true);
      return;
    }
    if (value === "{translateLangMenu}") {
      setTranslateLangOpen(true);
      return;
    }
    if (value === "{translate}") {
      void runToolbarTranslate();
      return;
    }
    if (value === "{aiReply}") {
      void runToolbarAIReply();
      return;
    }
    if (value === "{dismissKeyboard}") {
      CustomKeyboard.dismiss();
      return;
    }
    if (value === "{toggleSymbol}") {
      toggleSymbolLayer();
      return;
    }
    if (value.startsWith("script:")) {
      runToolbarScript(value.slice("script:".length));
      return;
    }
    if (value.startsWith("js:")) {
      void runToolbarInlineScript(value.slice("js:".length));
      return;
    }
    if (value.startsWith("keyboard:")) {
      switchKeyboardScript(value.slice("keyboard:".length));
      return;
    }
    if (value.startsWith("url:")) {
      openToolbarURL(value.slice("url:".length));
      return;
    }
    if (/^https?:\/\//i.test(value)) {
      openToolbarURL(value);
      return;
    }
    // 所有大括号令牌（{copy} {paste} {toggleSelectAll} {cut} 等）委派给
    // runConfiguredAction，让工具栏按钮能触发编辑/光标/Rime 等通用动作。
    if (/^\{.+\}$/.test(value)) {
      runConfiguredAction(value, "auto");
    }
  }

  // ==== 键盘内原地翻译 / AI 回复（默认工具栏原生令牌，开箱即用） ====
  // 直接读激活模型（ai_api）并用 fetch 单次非流式请求，结果上屏替换/追加。
  const AI_REQUEST_TIMEOUT_SECONDS = 20;

  function resolveKeyboardApiBase(baseUrl: string, mode: string) {
    let base = String(baseUrl ?? "").trim().replace(/\/+$/, "");
    if (!base) {
      if (mode === "openai") base = "https://api.openai.com";
      else if (mode === "gemini") base = "https://generativelanguage.googleapis.com";
      else if (mode === "siliconflow") base = "https://api.siliconflow.cn";
      else if (mode === "qwen") base = "https://dashscope.aliyuncs.com/compatible-mode";
    }
    base = base.replace(
      /\/(?:v1\/chat\/completions|chat\/completions|v1\/responses|responses|v1\/messages|messages|v1\/models|models|v1beta)$/i,
      "",
    );
    return base.replace(/\/+$/, "");
  }

  function containsHan(text: string) {
    for (const ch of String(text)) {
      const code = ch.charCodeAt(0);
      if (code >= 0x4e00 && code <= 0x9fff) return true;
    }
    return false;
  }

  function extractKeyboardAiText(data: any): string {
    const direct = data?.choices?.[0]?.message?.content
      ?? data?.output_text
      ?? data?.choices?.[0]?.text
      ?? data?.content?.[0]?.text
      ?? data?.candidates?.[0]?.content?.parts?.[0]?.text
      ?? "";
    return String(direct ?? "").trim();
  }

  type UsableActiveModel =
    | {
        kind: "ai_api";
        baseUrl: string;
        apiKey: string;
        model: string;
        compatibilityMode: string;
      }
    | {
        kind: "assistant";
        providerId: string;
        customProvider: string;
        modelId: string;
      };

  function getUsableActiveModel(): UsableActiveModel | null {
    const entry = getActiveModel();
    if (!entry || !isModelUsableInKeyboard(entry)) return null;

    if (entry.kind === "assistant") {
      return {
        kind: "assistant",
        providerId: String(entry.assistantProviderId ?? "openai"),
        customProvider: String(entry.assistantCustomProvider ?? ""),
        modelId: String(entry.assistantModelId ?? ""),
      };
    }

    return {
      kind: "ai_api",
      baseUrl: String(entry.baseUrl ?? ""),
      apiKey: String(entry.apiKey ?? ""),
      model: String(entry.model ?? ""),
      compatibilityMode: String(entry.compatibilityMode ?? "custom"),
    };
  }

  async function callKeyboardAI(
    model: { baseUrl: string; apiKey: string; model: string; compatibilityMode: string },
    systemPrompt: string,
    userText: string,
  ): Promise<string> {
    const mode = model.compatibilityMode || "custom";
    const base = resolveKeyboardApiBase(model.baseUrl, mode);
    if (!base) throw new Error("模型缺少 Base URL");
    if (!model.model) throw new Error("模型缺少模型名");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    let url: string;
    let body: string;
    if (mode === "gemini") {
      url = `${base}/v1beta/models/${encodeURIComponent(model.model)}:generateContent?key=${encodeURIComponent(model.apiKey)}`;
      body = JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
      });
    } else {
      const chatRoot = /\/v1$/i.test(base) ? base : `${base}/v1`;
      url = `${chatRoot}/chat/completions`;
      headers.Authorization = `Bearer ${model.apiKey}`;
      if (mode === "custom") {
        headers["x-api-key"] = model.apiKey;
        headers["api-key"] = model.apiKey;
      }
      body = JSON.stringify({
        model: model.model,
        temperature: 0.3,
        stream: false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText },
        ],
      });
    }

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body,
      timeout: AI_REQUEST_TIMEOUT_SECONDS,
    });
    let raw = "";
    try {
      raw = await resp.text();
    } catch {}
    if (!resp.ok) {
      throw new Error(
        `HTTP ${resp.status}${raw ? "：" + raw.replace(/\s+/g, " ").slice(0, 90) : ""}`,
      );
    }
    try {
      const data = JSON.parse(raw);
      const text = extractKeyboardAiText(data);
      if (!text) throw new Error("接口未返回内容");
      return text;
    } catch (error) {
      if (error instanceof Error && error.message.includes("接口未返回")) throw error;
      return String(raw).trim();
    }
  }

  // 键盘侧 Assistant 调用：走 App 原生 Assistant API，由 App 自己管理 Key。
  async function callAssistantAI(
    model: { providerId: string; customProvider: string; modelId: string },
    systemPrompt: string,
    userText: string,
  ): Promise<string> {
    const assistant = (globalThis as any).Assistant;
    if (!assistant?.requestStreaming) throw new Error("当前环境不支持 Assistant");

    const provider = model.providerId === "custom"
      ? (model.customProvider ? { custom: model.customProvider } : undefined)
      : model.providerId;

    const stream = await assistant.requestStreaming({
      systemPrompt,
      provider,
      modelId: model.modelId || undefined,
      messages: { role: "user", content: userText },
    });

    let result = "";
    for await (const chunk of stream as any) {
      if (chunk?.type !== "text") continue;
      result += String(chunk.content ?? "");
    }
    const trimmed = result.trim();
    if (!trimmed) throw new Error("Assistant 未返回内容");
    return trimmed;
  }

  // 统一的工具栏 AI入口：根据激活模型类型自动分发。
  async function invokeActiveModel(
    model: UsableActiveModel,
    systemPrompt: string,
    userText: string,
  ): Promise<string> {
    if (model.kind === "assistant") {
      return await callAssistantAI(
        { providerId: model.providerId, customProvider: model.customProvider, modelId: model.modelId },
        systemPrompt,
        userText,
      );
    }
    return await callKeyboardAI(
      {
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        model: model.model,
        compatibilityMode: model.compatibilityMode,
      },
      systemPrompt,
      userText,
    );
  }

  function chunkForTranslation(text: string, maxLen: number): string[] {
    const src = String(text ?? "");
    if (!src) return [];
    if (src.length <= maxLen) return [src];

    const chunks: string[] = [];
    const minCut = Math.floor(maxLen * 0.4);
    const sentenceEnders = [/。/g, /！/g, /？/g, /；/g, /，/g, /\. /g, /! /g, /\? /g, /; /g, /, /g];
    let rest = src;
    while (rest.length > maxLen) {
      const window = rest.slice(0, maxLen);
      let cut = -1;

      let idx = window.lastIndexOf("\n\n");
      if (idx >= minCut) {
        cut = idx + 2;
      } else {
        idx = window.lastIndexOf("\n");
        if (idx >= minCut) {
          cut = idx + 1;
        } else {
          let best = -1;
          for (const re of sentenceEnders) {
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(window)) !== null) {
              const end = m.index + m[0].length;
              if (end > best && end <= maxLen) best = end;
              if (m.index === re.lastIndex) re.lastIndex++;
            }
          }
          if (best >= minCut) {
            cut = best;
          } else {
            idx = window.lastIndexOf(" ");
            cut = idx >= 0 ? idx + 1 : maxLen;
          }
        }
      }
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) chunks.push(rest);
    return chunks;
  }

  async function translateChunksWithModel(
    model: UsableActiveModel,
    chunks: string[],
    targetName: string,
  ): Promise<string> {
    const systemPrompt =
      "You are a translation engine. Return ONLY the translated text, no explanation.";
    const parts: string[] = [];
    let failedChunks = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (chunks.length > 1) {
        showRimeNotificationToast(`翻译中 ${i + 1}/${chunks.length}…`);
      }
      let piece = "";
      // 每块最多重试两次：骑过临时网络/限流错误，避免整篇只译了后半段。
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          piece = await invokeActiveModel(
            model,
            systemPrompt,
            `Translate the following text to ${targetName}:\n\n${chunks[i]}`,
          );
          if (piece && piece.trim()) break;
        } catch (error) {
          if (chunks.length === 1) throw error;
          piece = "";
        }
      }
      if (piece && piece.trim()) {
        parts.push(piece);
      } else {
        failedChunks += 1;
        parts.push(chunks[i]);
      }
    }
    if (chunks.length > 1 && failedChunks > 0) {
      showRimeNotificationToast(`部分片段未翻译成功，已保留原文（${failedChunks}/${chunks.length}）`);
    }
    return parts.join("");
  }

  function handleTranslateLangPick(id: string) {
    setTranslateTargetLangId(id);
    setTranslateLangOpen(false);
    showRimeNotificationToast(`翻译目标语言：${translateLangLabel(id)}`);
  }

  const TRANSLATE_CHUNK_MAX_LEN = 1500;

  async function runToolbarTranslate() {
    if (aiBusyRef.current) {
      showRimeNotificationToast("AI 处理中，请稍候…");
      return;
    }
    const model = getUsableActiveModel();
    if (!model) {
      showRimeNotificationToast("请先在模型标签选择可用的 AI 模型");
      return;
    }
    const selected = CustomKeyboard.selectedText ?? "";
    const hasSelection = !!selected.trim();
    // iOS 键盘扩展读宿主文本受 textDocumentContext 限制，可能被截断；
    // 取「选中 / 全文 allText / 光标前」三者中最长的作为来源，尽量拿到完整内容。
    const rawSource = [
      selected,
      CustomKeyboard.allText || "",
      CustomKeyboard.textBeforeCursor || "",
    ].reduce((a, b) => (b.length > a.length ? b : a), "");
    const source = rawSource.trim();
    if (!source) {
      showRimeNotificationToast("没有可翻译的文本");
      return;
    }
    aiBusyRef.current = true;
    showRimeNotificationToast("翻译中…");
    try {
      const langId = getTranslateTargetLangId();
      const targetName = langId && langId !== "auto"
        ? translateLangName(langId)
        : (containsHan(source) ? "English" : "Chinese");
      const chunks = chunkForTranslation(source, TRANSLATE_CHUNK_MAX_LEN);
      const out = await translateChunksWithModel(model, chunks, targetName);
      const result = hasSelection ? out : `\n${out}`;
      Thread.runInMain(() => insertTextReplacingSelectAll(result));
      showRimeNotificationToast("翻译完成");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      showRimeNotificationToast(`翻译失败：${msg.replace(/\s+/g, " ").slice(0, 120)}`);
    } finally {
      aiBusyRef.current = false;
    }
  }

  async function runToolbarAIReply() {
    if (aiBusyRef.current) {
      showRimeNotificationToast("AI 处理中，请稍候…");
      return;
    }
    const model = getUsableActiveModel();
    if (!model) {
      showRimeNotificationToast("请先在模型标签选择可用的 AI 模型");
      return;
    }
    const before = CustomKeyboard.textBeforeCursor ?? "";
    const selected = CustomKeyboard.selectedText ?? "";
    const lines = before.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    // 不再读剪贴兜底：键盘扩展里调 Pasteboard.getString() 会触发系统粘贴横幅，
    // 很可能把键盘切回系统键盘（即“一点 AI 回复就变苹果自带键盘”的成因）。
    const prompt = selected.trim() || (lines.length ? lines[lines.length - 1] : "");
    if (!prompt) {
      showRimeNotificationToast("请先输入或选中要回复的内容");
      return;
    }
    aiBusyRef.current = true;
    showRimeNotificationToast("AI 回复中…");
    try {
      const out = await invokeActiveModel(
        model,
        "你是一名简洁的助手。根据用户给出的内容，直接生成一条可发送的回复，不要寒暄、不要解释、不要加引号。",
        prompt,
      );
      const result = before.trim() ? `\n${out}` : out;
      Thread.runInMain(() => insertTextReplacingSelectAll(result));
      showRimeNotificationToast("回复已上屏");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      showRimeNotificationToast(`回复失败：${msg.replace(/\s+/g, " ").slice(0, 120)}`);
    } finally {
      aiBusyRef.current = false;
    }
  }

  function refreshActiveModelLabel() {
    const entry = getActiveModel();
    setActiveModelLabel(entry ? (modelEntryLabel(entry) || "AI") : "AI");
  }

  function handleModelPick(entry: AiModelPoolEntry | null) {
    if (entry) {
      setActiveModel(entry);
      markUsed(entry.id);
      setActiveModelLabel(modelEntryLabel(entry) || "AI");
    }
    setModelPickerOpen(false);
  }

  useEffect(() => {
    if (modelPickerOpen) refreshActiveModelLabel();
  }, [modelPickerOpen]);

  const numericTouchFrame = (index: number) =>
    verticalTouchFrame(index, 4, metrics.keyHeight, numericRowSpacing);
  const numericBottomTouch = numericTouchFrame(3);
  const t9TouchFrame = (index: number) =>
    verticalTouchFrame(index, 3, metrics.keyHeight, numericRowSpacing);
  const bodyTouchFrame = (index: number, height: number) =>
    verticalTouchFrame(
      index,
      visibleBodyRowCount,
      height,
      bodyRowSpacing,
    );
  const functionRowTouch = bodyTouchFrame(0, metrics.functionKeyHeight);
  const bottomRowTouch = bodyTouchFrame(
    visibleBodyRowCount - 1,
    metrics.keyHeight,
  );
  const t9EnterOverlayHeight = isT9Keyboard
    ? metrics.keyHeight * 2 + t9PanelBottomInset +
      bottomRowTouch.visualOffsetY
    : 0;

  hitTargetActionsRef.current = {
    runWithFeedback,
    runCandidateMenuAction,
    selectCandidateFromHeader: (absoluteIndex: number) =>
      runWithFeedback(() => selectCandidateAbsolute(absoluteIndex)),
    runToolbarHeaderAction: (action: string) =>
      runWithFeedbackBeforeAction(
        () => runToolbarAction(action),
        EXIT_ACTION_FEEDBACK_DELAY,
      ),
    pressCandidateRightFromHeader: () => {
      const mode = settings.candidateRightButtonMode === "expand" &&
          currentCandidates().length === 0
        ? "dismiss"
        : settings.candidateRightButtonMode;
      runWithFeedbackBeforeAction(
        pressCandidateRightButton,
        mode === "dismiss" ? EXIT_ACTION_FEEDBACK_DELAY : 0,
      );
    },
    selectExpandedCandidate: (absoluteIndex: number) =>
      runWithFeedback(() => {
        selectCandidateAbsolute(absoluteIndex);
        setCandidateExpanded(false);
        setExpandedCandidates([]);
        setExpandedBatchHasMore(false);
      }),
    moveExpandedCandidatePage: (direction: "up" | "down") =>
      runWithFeedback(() => moveExpandedCandidateBatch(direction)),
    beginKeyTouch,
    endKeyTouch,
    pressShift,
    shiftSwipeUp,
    pressLetter,
    startLetterLongPress: (ch: string) => {
      holdKeyPressedUntilRelease(ch);
    },
    finishLetterLongPress,
    letterLongPressEnabled,
    runLetterSwipe,
    nextKeyboard: () => CustomKeyboard.nextKeyboard(),
    toggleSymbolLayer,
    pressBacktick: () => pressSymbol("`"),
    pressComma: pressKeyboardComma,
    pressPeriod: pressKeyboardPeriod,
    pressSpace,
    processSpaceSwipeCandidate,
    moveCursorSafely,
    pressMode: () => {
      if (
        keyboardTypeOverride === "qwerty" && settings.keyboardType === "t9"
      ) {
        switchEnglishQwertyToT9();
        return;
      }
      if (isT9Keyboard && !composing) {
        switchT9ToEnglishQwerty();
        return;
      }
      if (composing && settings.modeComposingEnabled) {
        runConfiguredAction(
          settings.modeComposingAction,
          settings.modeComposingActionMode,
        );
      } else {
        toggleAscii();
      }
    },
    modeSwipeUp: () =>
      runConfiguredAction(
        settings.modeComposingSwipeUp,
        settings.modeComposingSwipeUpMode,
      ),
    modeSwipeDown: () =>
      runConfiguredAction(
        settings.modeComposingSwipeDown,
        settings.modeComposingSwipeDownMode,
      ),
    pressReturn,
    insertNewline,
    switchToLetterLayer,
    pressNumericDigit,
    pressT9Digit,
    runT9PunctuationItem,
    pressT9Delimiter,
    runT9SpaceSwipe,
    selectT9Pinyin,
    pressBackspace,
    startRepeatingBackspace,
    startBackspaceLongPress: () => {
      holdKeyPressedUntilRelease("backspace");
      startRepeatingBackspace("backspace");
    },
    stopRepeatingBackspace,
    backspaceLongPressMove,
    backspaceSwipeLeft,
    backspaceSwipeUp,
    backspaceSwipeDown,
    pressNumericDot,
    pressEqual: () => pressSymbol("="),
    numericEqualSwipeUp: () =>
      runConfiguredAction(settings.numericEqualsSwipeUp, "rime"),
    runConfiguredAction,
    runComposingFunctionPress,
    runComposingFunctionSwipe,
    runIdleFunctionPress,
    runIdleFunctionSwipe,
    startRepeatingCursorMove,
    stopRepeatingCursorMove,
  };

  const onToolbarHeaderAction = useCallback(
    (action: string) =>
      hitTargetActionsRef.current.runToolbarHeaderAction(action),
    [],
  );
  const onCandidateMenuAction = useCallback(
    (absoluteIndex: number, action: string) =>
      hitTargetActionsRef.current.runCandidateMenuAction(absoluteIndex, action),
    [],
  );
  const onSelectCandidateFromHeader = useCallback(
    (absoluteIndex: number) =>
      hitTargetActionsRef.current.selectCandidateFromHeader(absoluteIndex),
    [],
  );
  const onCandidateRightButton = useCallback(
    () => hitTargetActionsRef.current.pressCandidateRightFromHeader(),
    [],
  );
  const onSelectExpandedCandidate = useCallback(
    (absoluteIndex: number) =>
      hitTargetActionsRef.current.selectExpandedCandidate(absoluteIndex),
    [],
  );
  const onMoveExpandedCandidatePage = useCallback(
    (direction: "up" | "down") =>
      hitTargetActionsRef.current.moveExpandedCandidatePage(direction),
    [],
  );

  const cachedComposingFunctionHitTargets = useMemo(
    () =>
      usesT9MixedFunctionRow
        ? t9MixedFunctionHitTargets()
        : composingFunctionHitTargets(),
    [
      metrics.functionWidth8,
      settings.composingFunctionOrder,
      settings.idleFunctionOrder,
      usesT9MixedFunctionRow,
    ],
  );
  const cachedIdleFunctionHitTargets = useMemo(
    () => idleFunctionHitTargets(),
    [
      metrics.functionWidth8,
      settings.idleFunctionOrder,
    ],
  );
  const cachedBottomRowHitTargets = useMemo(
    () => bottomRowHitTargets(),
    [
      showNextKeyboardButton,
      bottomSplitButtonWidth,
      bottomNumbersWidth,
      bottomCommaWidth,
      bottomSpaceWidth,
      bottomModeWidth,
      bottomEnterWidth,
      ascii,
      composing,
      settings.modeComposingEnabled,
      isT9Keyboard,
      keyboardTypeOverride,
      isT9Keyboard ? settings.t9SpaceSwipeUp : null,
      isT9Keyboard ? settings.t9SpaceSwipeUpMode : null,
      isT9Keyboard ? settings.t9SpaceSwipeDown : null,
      isT9Keyboard ? settings.t9SpaceSwipeDownMode : null,
      hasSecondCandidate,
      hasThirdCandidate,
    ],
  );
  const cachedNumericDigitHitTargets = useMemo(
    () =>
      symbolLayer
        ? NUMERIC_DIGIT_ROWS.map((row) => numericRowHitTargets(row))
        : [],
    [
      numericKeyWidth,
      symbolLayer,
      symbolLayer ? Number(rimeComposing) : 0,
      symbolLayer ? Number(hasSecondCandidate) : 0,
      symbolLayer ? Number(hasThirdCandidate) : 0,
    ],
  );
  const cachedNumericBottomHitTargets = useMemo(
    () => symbolLayer ? numericRowHitTargets(NUMERIC_BOTTOM_ROW) : [],
    [
      numericKeyWidth,
      symbolLayer,
      symbolLayer ? Number(rimeComposing) : 0,
      symbolLayer ? Number(hasSecondCandidate) : 0,
      symbolLayer ? Number(hasThirdCandidate) : 0,
    ],
  );
  const cachedNumericRightHitTargets = useMemo(
    () => numericRightHitTargets(),
    [
      numericRightWidth,
      metrics.keyHeight,
      numericRowSpacing,
    ],
  );
  const cachedT9DigitRows = useMemo(
    () =>
      isT9Keyboard
        ? T9_KEY_ROWS.map((row, rowIndex) => {
          const rowTouch = t9TouchFrame(rowIndex);
          return (
            <HStack
              key={`t9-row-${rowIndex}`}
              spacing={0}
              frame={{
                width: t9CenterWidth,
                height: rowTouch.touchHeight,
              }}
            >
              {row.map((item, index) => {
                const label = settings.uppercaseLetterLabels
                  ? item.letters
                  : item.letters.toLowerCase();
                const touchWidth = t9KeyWidth +
                  (index === 0 || index === row.length - 1
                    ? KEY_SPACING / 2
                    : KEY_SPACING);
                return (
                  <KeyFace
                    key={`t9-${item.digit}`}
                    id={`t9-${item.digit}`}
                    label={label}
                    topLeft={settings.t9KeySwipeUp[item.digit]}
                    topRight={settings.t9KeySwipeDown[item.digit] || undefined}
                    palette={palette}
                    width={t9KeyWidth}
                    height={metrics.keyHeight}
                    touchWidth={touchWidth}
                    touchHeight={rowTouch.touchHeight}
                    visualOffsetX={index === 0 ? 0 : KEY_SPACING / 2}
                    visualOffsetY={rowTouch.visualOffsetY}
                    labelFontSize={item.letters.length > 3 ? 20 : 22}
                    active={isPressed(`t9-${item.digit}`)}
                    popupLabel={label}
                    popupSwipeUpLabel={settings.t9KeySwipeUp[item.digit]}
                    popupSwipeDownLabel={settings.t9KeySwipeDown[item.digit] ||
                      undefined}
                    showPopup={settings.showKeyPopups}
                    onPress={() =>
                      hitTargetActionsRef.current.pressT9Digit(item.digit)}
                    onTouchStart={() =>
                      hitTargetActionsRef.current.beginKeyTouch(
                        `t9-${item.digit}`,
                      )}
                    onTouchEnd={() =>
                      hitTargetActionsRef.current.endKeyTouch(
                        `t9-${item.digit}`,
                      )}
                    onSwipeUp={() =>
                      hitTargetActionsRef.current.runConfiguredAction(
                        settings.t9KeySwipeUp[item.digit],
                        settings.t9KeySwipeUpModes[item.digit],
                      )}
                    onSwipeDown={() =>
                      hitTargetActionsRef.current.runConfiguredAction(
                        settings.t9KeySwipeDown[item.digit],
                        settings.t9KeySwipeDownModes[item.digit],
                      )}
                    swipeTriggerDistance={settings.swipeTriggerDistance}
                  />
                );
              })}
            </HStack>
          );
        })
        : null,
    [
      isT9Keyboard,
      metrics.keyHeight,
      palette,
      settings,
      t9CenterWidth,
      t9KeyWidth,
    ],
  );
  function renderQwertyLetterRow(row: string[], rowIndex: number) {
    const sideInset = rowIndex === 1 ? metrics.secondRowInset : 0;
    const rowTouch = bodyTouchFrame(
      (settings.showFunctionRow ? 1 : 0) + rowIndex,
      metrics.keyHeight,
    );
    const letterTouchWidth = (index: number) => {
      if (rowIndex === 0) {
        return metrics.letterWidth +
          (index === 0 || index === row.length - 1
            ? KEY_SPACING / 2
            : KEY_SPACING);
      }
      if (rowIndex === 2) return metrics.letterWidth + KEY_SPACING;
      if (index === 0) {
        return sideInset + metrics.letterWidth + KEY_SPACING / 2;
      }
      if (index === row.length - 1) {
        return metrics.letterWidth + sideInset + KEY_SPACING / 2;
      }
      return metrics.letterWidth + KEY_SPACING;
    };
    const letterVisualOffset = (index: number) =>
      rowIndex === 0
        ? index === 0 ? 0 : KEY_SPACING / 2
        : rowIndex === 2
        ? KEY_SPACING / 2
        : index === 0
        ? sideInset
        : KEY_SPACING / 2;
    return (
      <HStack
        key={`row-${rowIndex}`}
        spacing={0}
        frame={{
          width: metrics.width,
          height: rowTouch.touchHeight,
        }}
        zIndex={10 + rowIndex}
      >
        {rowIndex === 2
          ? (
            <KeyFace
              id="shift"
              image={composing && settings.shiftComposingEnabled
                ? settings.shiftComposingIcon
                : capsLocked
                ? "capslock.fill"
                : shifted
                ? "shift.fill"
                : "shift"}
              palette={palette}
              width={metrics.shiftWidth}
              height={metrics.keyHeight}
              touchWidth={metrics.shiftWidth + KEY_SPACING / 2}
              touchHeight={rowTouch.touchHeight}
              visualOffsetX={0}
              visualOffsetY={rowTouch.visualOffsetY}
              system
              selected={shifted || capsLocked}
              active={isPressed("shift")}
              onPress={() => hitTargetActionsRef.current.pressShift()}
              onTouchStart={() =>
                hitTargetActionsRef.current.beginKeyTouch("shift")}
              onTouchEnd={() =>
                hitTargetActionsRef.current.endKeyTouch("shift")}
              onSwipeUp={() => hitTargetActionsRef.current.shiftSwipeUp()}
              onSwipeStart={() =>
                hitTargetActionsRef.current.stopRepeatingBackspace()}
              swipeTriggerDistance={settings.swipeTriggerDistance}
            />
          )
          : null}
        {row.map((ch, index) => {
          const letterLabel = backslashWrapMode
            ? BACKSLASH_SYMBOLS[ch]
            : shifted || capsLocked || settings.uppercaseLetterLabels
            ? ch.toUpperCase()
            : ch;
          const swipeUpImage = !backslashWrapMode &&
              settings.showHintSymbols
            ? settings.letterSwipeUpSymbols[ch] || undefined
            : undefined;
          const swipeUpLabel = !backslashWrapMode &&
              settings.showHintSymbols && !swipeUpImage
            ? settings.letterSwipeUp[ch]
            : undefined;
          const swipeDownImage = !backslashWrapMode &&
              settings.showHintSymbols
            ? settings.letterSwipeDownSymbols[ch] || undefined
            : undefined;
          const swipeDownLabel = !backslashWrapMode &&
              settings.showHintSymbols && !swipeDownImage
            ? settings.letterSwipeDown[ch]
            : undefined;
          return (
            <KeyFace
              key={ch}
              id={ch}
              label={letterLabel}
              labelFontSize={backslashWrapMode
                ? BACKSLASH_SYMBOLS[ch].length > 2 ? 16 : 22
                : shifted || capsLocked || settings.uppercaseLetterLabels
                ? 24
                : 27}
              topLeft={swipeUpLabel}
              topLeftImage={swipeUpImage}
              topRight={swipeDownLabel}
              topRightImage={swipeDownImage}
              palette={palette}
              width={metrics.letterWidth}
              height={metrics.keyHeight}
              touchWidth={letterTouchWidth(index)}
              touchHeight={rowTouch.touchHeight}
              visualOffsetX={letterVisualOffset(index)}
              visualOffsetY={rowTouch.visualOffsetY}
              active={isPressed(ch)}
              popupLabel={letterLabel}
              popupSwipeUpLabel={swipeUpLabel}
              popupSwipeUpImage={swipeUpImage}
              popupSwipeDownLabel={swipeDownLabel}
              popupSwipeDownImage={swipeDownImage}
              longPressPopupOptions={{ lower: ch, upper: ch.toUpperCase() }}
              showPopup={settings.showKeyPopups}
              onPress={() => hitTargetActionsRef.current.pressLetter(ch)}
              onTouchStart={() => hitTargetActionsRef.current.beginKeyTouch(ch)}
              onTouchEnd={() => hitTargetActionsRef.current.endKeyTouch(ch)}
              onLongPress={() =>
                hitTargetActionsRef.current.startLetterLongPress(ch)}
              onLongPressOptionEnd={(selection) =>
                hitTargetActionsRef.current.finishLetterLongPress(
                  ch,
                  selection,
                )}
              longPressEnabled={() =>
                hitTargetActionsRef.current.letterLongPressEnabled()}
              longPressDuration={settings.letterLongPressDuration}
              onSwipeUp={() =>
                hitTargetActionsRef.current.runLetterSwipe("up", ch)}
              onSwipeDown={() =>
                hitTargetActionsRef.current.runLetterSwipe("down", ch)}
              swipeTriggerDistance={settings.swipeTriggerDistance}
            />
          );
        })}
        {rowIndex === 2
          ? (
            <KeyFace
              id="backspace"
              image="delete.left"
              palette={palette}
              width={metrics.shiftWidth}
              height={metrics.keyHeight}
              touchWidth={metrics.shiftWidth + KEY_SPACING / 2}
              touchHeight={rowTouch.touchHeight}
              visualOffsetX={KEY_SPACING / 2}
              visualOffsetY={rowTouch.visualOffsetY}
              system
              active={isPressed("backspace")}
              onPress={() => hitTargetActionsRef.current.pressBackspace()}
              onTouchStart={() =>
                hitTargetActionsRef.current.beginKeyTouch("backspace")}
              onTouchEnd={() =>
                hitTargetActionsRef.current.endKeyTouch("backspace")}
              onLongPress={() =>
                hitTargetActionsRef.current.startBackspaceLongPress()}
              onLongPressEnd={() =>
                hitTargetActionsRef.current.stopRepeatingBackspace()}
              onLongPressMove={(details) =>
                hitTargetActionsRef.current.backspaceLongPressMove(details)}
              longPressDuration={DELETE_LONG_PRESS_DURATION}
              onSwipeLeft={() =>
                hitTargetActionsRef.current.backspaceSwipeLeft()}
              onSwipeUp={() => hitTargetActionsRef.current.backspaceSwipeUp()}
              onSwipeDown={() =>
                hitTargetActionsRef.current.backspaceSwipeDown()}
              onSwipeStart={() =>
                hitTargetActionsRef.current.stopRepeatingBackspace()}
              swipeTriggerDistance={settings.swipeTriggerDistance}
            />
          )
          : null}
      </HStack>
    );
  }
  const cachedQwertyUpperRows = useMemo(
    () =>
      isT9Keyboard ? null : LETTER_ROWS.slice(0, 2).map(renderQwertyLetterRow),
    [
      backslashWrapMode,
      bodyRowSpacing,
      capsLocked,
      isT9Keyboard,
      metrics,
      palette,
      settings,
      shifted,
      visibleBodyRowCount,
    ],
  );
  const cachedQwertyBottomLetterRow = useMemo(
    () => isT9Keyboard ? null : renderQwertyLetterRow(LETTER_ROWS[2], 2),
    [
      backslashWrapMode,
      bodyRowSpacing,
      capsLocked,
      composing,
      isT9Keyboard,
      metrics,
      palette,
      settings,
      shifted,
      visibleBodyRowCount,
    ],
  );
  const cachedFunctionRow = useMemo(() => {
    if (!settings.showFunctionRow) return null;
    if (usesComposingFunctionRow) {
      return (
        <HStack
          spacing={KEY_SPACING}
          frame={{
            width: metrics.width,
            height: functionRowTouch.touchHeight,
          }}
          contentShape="rect"
          highPriorityGesture={hitRowGesture(
            "func-comp",
            cachedComposingFunctionHitTargets,
          )}
        >
          {settings.composingFunctionOrder.map(
            usesT9MixedFunctionRow
              ? renderT9MixedFunctionKey
              : renderComposingFunctionKey,
          )}
        </HStack>
      );
    }
    return (
      <HStack
        spacing={KEY_SPACING}
        frame={{
          width: metrics.width,
          height: functionRowTouch.touchHeight,
        }}
        contentShape="rect"
        highPriorityGesture={hitRowGesture(
          "func-idle",
          cachedIdleFunctionHitTargets,
        )}
      >
        {settings.idleFunctionOrder.map(renderIdleFunctionKey)}
      </HStack>
    );
  }, [
    cachedComposingFunctionHitTargets,
    cachedIdleFunctionHitTargets,
    functionRowTouch.touchHeight,
    metrics,
    palette,
    selectAllActive,
    settings,
    usesComposingFunctionRow,
    usesT9MixedFunctionRow,
  ]);
  const cachedQwertyBottomRow = useMemo(() => {
    if (symbolLayer || isT9Keyboard) return null;
    const run = (action: () => void) =>
      hitTargetActionsRef.current.runWithFeedback(action);
    return (
      <HStack
        spacing={KEY_SPACING}
        frame={{
          width: metrics.width,
          height: bottomRowTouch.touchHeight,
        }}
        contentShape="rect"
        highPriorityGesture={hitRowGesture(
          "bottom-row",
          cachedBottomRowHitTargets,
        )}
      >
        {showNextKeyboardButton
          ? (
            <KeyFace
              id="next-keyboard"
              image="globe"
              palette={palette}
              width={bottomSplitButtonWidth}
              height={metrics.keyHeight}
              touchHeight={bottomRowTouch.touchHeight}
              visualOffsetY={bottomRowTouch.visualOffsetY}
              system
              passive
              active={isPressed("next-keyboard")}
              onPress={() =>
                run(() => hitTargetActionsRef.current.nextKeyboard())}
            />
          )
          : null}
        <KeyFace
          id="numbers"
          label="123"
          palette={palette}
          width={showNextKeyboardButton
            ? bottomSplitButtonWidth
            : bottomNumbersWidth}
          height={metrics.keyHeight}
          touchHeight={bottomRowTouch.touchHeight}
          visualOffsetY={bottomRowTouch.visualOffsetY}
          system
          passive
          active={isPressed("numbers")}
          onPress={() =>
            run(() => hitTargetActionsRef.current.toggleSymbolLayer())}
          onSwipeUp={() =>
            run(() => hitTargetActionsRef.current.pressBacktick())}
        />
        <KeyFace
          id="comma"
          label=","
          topCenter="."
          topCenterForeground={palette.primary}
          palette={palette}
          width={bottomCommaWidth}
          height={metrics.keyHeight}
          touchHeight={bottomRowTouch.touchHeight}
          visualOffsetY={bottomRowTouch.visualOffsetY}
          passive
          active={isPressed("comma")}
          onPress={() => run(() => hitTargetActionsRef.current.pressComma())}
          onSwipeUp={() => run(() => hitTargetActionsRef.current.pressPeriod())}
        />
        <KeyFace
          id="space"
          image="space"
          bottomRight={settings.showWanxiangLabel
            ? settings.spaceLabel
            : undefined}
          bottomRightFontSize={settings.spaceLabel.length > 4
            ? 8
            : settings.spaceLabel.length > 2
            ? 10
            : 12}
          palette={palette}
          width={bottomSpaceWidth}
          height={metrics.keyHeight}
          touchHeight={bottomRowTouch.touchHeight}
          visualOffsetY={bottomRowTouch.visualOffsetY}
          system
          passive
          active={isPressed("space")}
          onPress={() => run(() => hitTargetActionsRef.current.pressSpace())}
          onSwipeUp={() =>
            run(() =>
              hitTargetActionsRef.current.processSpaceSwipeCandidate("2")
            )}
          onSwipeDown={() =>
            run(() =>
              hitTargetActionsRef.current.processSpaceSwipeCandidate("3")
            )}
          onSwipeLeft={() =>
            run(() => hitTargetActionsRef.current.moveCursorSafely(-1))}
          onSwipeRight={() =>
            run(() => hitTargetActionsRef.current.moveCursorSafely(1))}
        />
        <KeyFace
          id="mode"
          image={composing && settings.modeComposingEnabled
            ? settings.modeComposingIcon
            : undefined}
          modeTopLeft={composing && settings.modeComposingEnabled
            ? undefined
            : "中"}
          modeBottomRight={composing && settings.modeComposingEnabled
            ? undefined
            : "英"}
          modeTopLeftActive={!ascii}
          palette={palette}
          width={bottomModeWidth}
          height={metrics.keyHeight}
          touchHeight={bottomRowTouch.touchHeight}
          visualOffsetY={bottomRowTouch.visualOffsetY}
          system
          passive
          active={isPressed("mode")}
          labelFontSize={18}
          onPress={() => run(() => hitTargetActionsRef.current.pressMode())}
          onSwipeUp={() => run(() => hitTargetActionsRef.current.modeSwipeUp())}
          onSwipeDown={() =>
            run(() => hitTargetActionsRef.current.modeSwipeDown())}
          contextMenu={schemaMenu != null
            ? { menuItems: schemaMenu }
            : undefined}
        />
        <KeyFace
          id="enter"
          image="paperplane.fill"
          palette={palette}
          width={bottomEnterWidth}
          height={metrics.keyHeight}
          touchHeight={bottomRowTouch.touchHeight}
          visualOffsetY={bottomRowTouch.visualOffsetY}
          system
          passive
          active={isPressed("enter")}
          onPress={() => run(() => hitTargetActionsRef.current.pressReturn())}
          onSwipeUp={() =>
            run(() => hitTargetActionsRef.current.insertNewline())}
        />
      </HStack>
    );
  }, [
    ascii,
    bottomCommaWidth,
    bottomEnterWidth,
    bottomModeWidth,
    bottomNumbersWidth,
    bottomRowTouch.touchHeight,
    bottomRowTouch.visualOffsetY,
    bottomSpaceWidth,
    bottomSplitButtonWidth,
    cachedBottomRowHitTargets,
    composing,
    isT9Keyboard,
    metrics,
    palette,
    schemaMenu,
    settings,
    showNextKeyboardButton,
    symbolLayer,
  ]);

  function renderT9LeftColumn() {
    const bg = palette.keyOverrides["t9-left-column"] ?? palette.keyBg;
    const fg = palette.primaryOverrides["t9-left-column"] ?? palette.primary;
    const items = t9PinyinOptions.length > 0
      ? t9PinyinOptions.map((option) => ({
        key: `pinyin-${option.digits}-${option.selected.join("'")}`,
        label: option.label,
        action: () => hitTargetActionsRef.current.selectT9Pinyin(option),
      }))
      : settings.t9PunctuationItems
        .filter((item) =>
          item.label.trim().length > 0 && item.action.trim().length > 0
        )
        .map((item, index) => ({
          key: `punct-${index}-${item.label}-${item.action}`,
          label: item.label,
          action: () => hitTargetActionsRef.current.runT9PunctuationItem(item),
        }));
    return (
      <ZStack
        frame={{ width: t9LeftWidth, height: t9PanelHeight }}
        background={palette.nativeKeyStyle
          ? palette.usesCustomColors ? bg as any : "clear" as any
          : bg as any}
        foregroundStyle={fg as any}
        glassEffect={(palette.nativeKeyStyle
          ? { type: "rect", cornerRadius: 8 }
          : undefined) as any}
        clipShape={{ type: "rect", cornerRadius: 8 }}
        shadow={palette.nativeKeyStyle ? undefined : {
          color: palette.shadow as any,
          radius: 1,
          y: 1,
        }}
      >
        <ScrollView
          axes="vertical"
          scrollIndicator="hidden"
          frame={{ width: t9LeftWidth, height: t9PanelHeight }}
        >
          <VStack
            spacing={0}
            frame={{ width: t9LeftWidth, alignment: "top" as any }}
          >
            {items.map((item) => (
              <Text
                key={item.key}
                font={t9PinyinOptions.length > 0 ? 13 : 18}
                lineLimit={1}
                minScaleFactor={0.7}
                foregroundStyle={fg as any}
                frame={{
                  width: t9LeftWidth,
                  height: t9PanelHeight / 4,
                  alignment: "center" as any,
                }}
                contentShape="rect"
                onTapGesture={() =>
                  item.key.startsWith("pinyin-")
                    ? item.action()
                    : runWithFeedback(item.action)}
              >
                {item.label}
              </Text>
            ))}
          </VStack>
        </ScrollView>
      </ZStack>
    );
  }

  return (
    <KeyPressVisualContext.Provider value={pressVisualControllerRef.current}>
      <ZStack
        frame={{
          width: metrics.width + SIDE_PADDING * 2,
          maxHeight: "infinity" as any,
          alignment: "top" as any,
        }}
      >
      <VStack
        spacing={6}
        padding={{ horizontal: SIDE_PADDING, top: 4, bottom: 2 }}
        frame={{
          width: metrics.width + SIDE_PADDING * 2,
          maxHeight: "infinity" as any,
        }}
      >
        <CandidateHeader
          controller={rimeViewStateControllerRef.current!}
          settings={settings}
          metrics={metrics}
          palette={palette}
          displayPreedit={isT9Keyboard ? keyboardPreedit : undefined}
          displayPreeditCursor={isT9Keyboard ? safePreeditCursor : undefined}
          error={error}
          composing={composing}
          candidateExpanded={candidateExpanded}
          notificationToast={rimeNotificationToast}
          candidateMenuActions={candidateMenuActions}
          schemaMenu={schemaMenu}
          activeModelLabel={activeModelLabel}
          onToolbarAction={onToolbarHeaderAction}
          onCandidateAction={onCandidateMenuAction}
          onSelectCandidate={onSelectCandidateFromHeader}
          onRightButton={onCandidateRightButton}
          onRenderCommit={onCandidateRenderCommit}
        />

        <ZStack frame={{ width: metrics.width, height: expandedPanelHeight }}>
          <VStack
            spacing={0}
            frame={{
              width: metrics.width,
              height: expandedPanelHeight,
              alignment: "top" as any,
            }}
            opacity={candidateExpanded ? 0 : 1}
          >
            <Group>
              {modelPickerOpen
                ? (
                  <ModelPickerSurface
                    height={metrics.functionKeyHeight + MODEL_PICKER_EXTRA}
                    activeLabel={activeModelLabel}
                    query={modelSearchQuery}
                    onClearQuery={() => setModelSearchQuery("")}
                    onPick={handleModelPick}
                    onClose={() => setModelPickerOpen(false)}
                  />
                )
                : cachedFunctionRow}

              {symbolLayer
                ? (
                  <VStack
                    spacing={0}
                    frame={{
                      width: metrics.width,
                      height: numericPanelHeight + numericPanelTopInset,
                      alignment: "topLeading" as any,
                    }}
                  >
                    {numericPanelTopInset > 0
                      ? (
                        <VStack
                          frame={{
                            width: metrics.width,
                            height: numericPanelTopInset,
                          }}
                        />
                      )
                      : null}
                    <HStack
                      spacing={KEY_SPACING}
                      frame={{
                        width: metrics.width,
                        height: numericPanelHeight,
                      }}
                    >
                      <ZStack
                        frame={{
                          width: numericLeftWidth,
                          height: numericPanelHeight,
                        }}
                        background={palette.nativeKeyStyle
                          ? "clear" as any
                          : palette.keyBg as any}
                        foregroundStyle={palette.primary as any}
                        glassEffect={(palette.nativeKeyStyle
                          ? { type: "rect", cornerRadius: 8 }
                          : undefined) as any}
                        clipShape={{ type: "rect", cornerRadius: 8 }}
                        shadow={palette.nativeKeyStyle ? undefined : {
                          color: palette.shadow as any,
                          radius: 1,
                          y: 1,
                        }}
                      >
                        <ScrollView
                          axes="vertical"
                          scrollIndicator="hidden"
                          frame={{
                            width: numericLeftWidth,
                            height: numericPanelHeight,
                          }}
                        >
                          <VStack
                            spacing={0}
                            frame={{
                              width: numericLeftWidth,
                              alignment: "top" as any,
                            }}
                          >
                            {NUMERIC_SYMBOLS.map((item) => (
                              <Text
                                key={`numeric-symbol-${item.label}`}
                                font={18}
                                frame={{
                                  width: numericLeftWidth,
                                  height: numericPanelHeight / 5,
                                  alignment: "center" as any,
                                }}
                                contentShape="rect"
                                onTapGesture={() =>
                                  runWithFeedback(() =>
                                    pressSymbol(item.value)
                                  )}
                              >
                                {item.label}
                              </Text>
                            ))}
                          </VStack>
                        </ScrollView>
                      </ZStack>

                      <VStack
                        spacing={0}
                        frame={{
                          width: numericCenterWidth,
                          height: numericPanelHeight,
                        }}
                      >
                        {NUMERIC_DIGIT_ROWS.map((row, rowIndex) => {
                          const hitTargets =
                            cachedNumericDigitHitTargets[rowIndex] ?? [];
                          const rowTouch = numericTouchFrame(rowIndex);
                          return (
                            <HStack
                              key={`numeric-row-${rowIndex}`}
                              spacing={KEY_SPACING}
                              frame={{
                                width: numericCenterWidth,
                                height: rowTouch.touchHeight,
                              }}
                              contentShape="rect"
                              highPriorityGesture={hitRowGesture(
                                `num-row-${rowIndex}`,
                                hitTargets,
                              )}
                            >
                              {row.map((value) => (
                                <KeyFace
                                  key={`numeric-${value}`}
                                  id={`numeric-${value}`}
                                  label={value}
                                  palette={palette}
                                  width={numericKeyWidth}
                                  height={metrics.keyHeight}
                                  touchHeight={rowTouch.touchHeight}
                                  visualOffsetY={rowTouch.visualOffsetY}
                                  labelFontSize={24}
                                  passive
                                  active={isPressed(`numeric-${value}`)}
                                  popupLabel={value}
                                  showPopup={settings.showKeyPopups}
                                  onPress={() =>
                                    runWithFeedback(() =>
                                      pressNumericDigit(value)
                                    )}
                                />
                              ))}
                            </HStack>
                          );
                        })}
                        <HStack
                          spacing={KEY_SPACING}
                          frame={{
                            width: numericCenterWidth,
                            height: numericBottomTouch.touchHeight,
                          }}
                          contentShape="rect"
                          highPriorityGesture={hitRowGesture(
                            "num-row-zero",
                            cachedNumericBottomHitTargets,
                          )}
                        >
                          <KeyFace
                            id="numeric-abc"
                            label="ABC"
                            palette={palette}
                            width={numericKeyWidth}
                            height={metrics.keyHeight}
                            touchHeight={numericBottomTouch.touchHeight}
                            visualOffsetY={numericBottomTouch.visualOffsetY}
                            system
                            labelFontSize={16}
                            passive
                            active={isPressed("numeric-abc")}
                            onPress={() => runWithFeedback(switchToLetterLayer)}
                          />
                          <KeyFace
                            id="numeric-0"
                            label="0"
                            palette={palette}
                            width={numericKeyWidth}
                            height={metrics.keyHeight}
                            touchHeight={numericBottomTouch.touchHeight}
                            visualOffsetY={numericBottomTouch.visualOffsetY}
                            labelFontSize={24}
                            passive
                            active={isPressed("numeric-0")}
                            popupLabel="0"
                            showPopup={settings.showKeyPopups}
                            onPress={() =>
                              runWithFeedback(() => pressNumericDigit("0"))}
                          />
                          <KeyFace
                            id="numeric-space"
                            image="space"
                            palette={palette}
                            width={numericKeyWidth}
                            height={metrics.keyHeight}
                            touchHeight={numericBottomTouch.touchHeight}
                            visualOffsetY={numericBottomTouch.visualOffsetY}
                            system
                            passive
                            active={isPressed("numeric-space")}
                            onPress={() => runWithFeedback(pressSpace)}
                          />
                        </HStack>
                      </VStack>

                      <VStack
                        spacing={0}
                        frame={{
                          width: numericRightWidth,
                          height: numericPanelHeight,
                        }}
                        contentShape="rect"
                        highPriorityGesture={hitRowGesture(
                          "num-row-right",
                          cachedNumericRightHitTargets,
                        )}
                      >
                        <KeyFace
                          id="numeric-backspace"
                          image="delete.left"
                          palette={palette}
                          width={numericRightWidth}
                          height={metrics.keyHeight}
                          touchHeight={numericTouchFrame(0).touchHeight}
                          visualOffsetY={numericTouchFrame(0).visualOffsetY}
                          system
                          passive
                          active={isPressed("numeric-backspace")}
                          onPress={() => runWithFeedback(pressBackspace)}
                          onSwipeLeft={() =>
                            runWithFeedback(backspaceSwipeLeft)}
                          onSwipeUp={() => runWithFeedback(backspaceSwipeUp)}
                          onSwipeDown={() =>
                            runWithFeedback(backspaceSwipeDown)}
                        />
                        <KeyFace
                          id="numeric-dot"
                          label="."
                          palette={palette}
                          width={numericRightWidth}
                          height={metrics.keyHeight}
                          touchHeight={numericTouchFrame(1).touchHeight}
                          visualOffsetY={numericTouchFrame(1).visualOffsetY}
                          passive
                          active={isPressed("numeric-dot")}
                          onPress={() => runWithFeedback(pressNumericDot)}
                        />
                        <KeyFace
                          id="numeric-equal"
                          label="="
                          palette={palette}
                          width={numericRightWidth}
                          height={metrics.keyHeight}
                          touchHeight={numericTouchFrame(2).touchHeight}
                          visualOffsetY={numericTouchFrame(2).visualOffsetY}
                          passive
                          active={isPressed("numeric-equal")}
                          onPress={() =>
                            runWithFeedback(() => pressSymbol("="))}
                          onSwipeUp={() =>
                            runWithFeedback(() => runConfiguredAction(
                              settings.numericEqualsSwipeUp,
                              "rime",
                            ))}
                        />
                        <KeyFace
                          id="numeric-enter"
                          image="paperplane.fill"
                          palette={palette}
                          width={numericRightWidth}
                          height={metrics.keyHeight}
                          touchHeight={numericBottomTouch.touchHeight}
                          visualOffsetY={numericBottomTouch.visualOffsetY}
                          system
                          passive
                          active={isPressed("numeric-enter")}
                          onPress={() => runWithFeedback(pressReturn)}
                          onSwipeUp={() => runWithFeedback(insertNewline)}
                        />
                      </VStack>
                    </HStack>
                  </VStack>
                )
                : isT9Keyboard
                ? (
                  <HStack
                    spacing={KEY_SPACING}
                    frame={{
                      width: metrics.width,
                      height: t9PanelHeight + t9PanelTopInset +
                        t9PanelBottomInset + bottomRowTouch.touchHeight,
                      alignment: "topLeading" as any,
                    }}
                  >
                    <VStack
                      spacing={0}
                      frame={{
                        width: metrics.width - t9RightWidth - KEY_SPACING,
                        height: t9PanelHeight + t9PanelTopInset +
                          t9PanelBottomInset + bottomRowTouch.touchHeight,
                        alignment: "topLeading" as any,
                      }}
                    >
                      <VStack
                        spacing={0}
                        frame={{
                          width: metrics.width - t9RightWidth - KEY_SPACING,
                          height: t9PanelHeight + t9PanelTopInset +
                            t9PanelBottomInset,
                          alignment: "topLeading" as any,
                        }}
                      >
                        {t9PanelTopInset > 0
                          ? (
                            <VStack
                              frame={{
                                width: metrics.width - t9RightWidth -
                                  KEY_SPACING,
                                height: t9PanelTopInset,
                              }}
                            />
                          )
                          : null}
                        <HStack
                          spacing={KEY_SPACING}
                          frame={{
                            width: metrics.width - t9RightWidth - KEY_SPACING,
                            height: t9PanelHeight,
                          }}
                        >
                          {renderT9LeftColumn()}
                          <VStack
                            spacing={0}
                            frame={{
                              width: t9CenterWidth,
                              height: t9PanelHeight,
                            }}
                          >
                            {cachedT9DigitRows}
                          </VStack>
                        </HStack>
                        {t9PanelBottomInset > 0
                          ? (
                            <VStack
                              frame={{
                                width: metrics.width - t9RightWidth -
                                  KEY_SPACING,
                                height: t9PanelBottomInset,
                              }}
                            />
                          )
                          : null}
                      </VStack>
                      <HStack
                        spacing={KEY_SPACING}
                        frame={{
                          width: metrics.width - t9RightWidth - KEY_SPACING,
                          height: bottomRowTouch.touchHeight,
                        }}
                        contentShape="rect"
                        highPriorityGesture={hitRowGesture(
                          "bottom-row",
                          cachedBottomRowHitTargets,
                        )}
                      >
                        {showNextKeyboardButton
                          ? (
                            <KeyFace
                              id="next-keyboard"
                              image="globe"
                              palette={palette}
                              width={bottomSplitButtonWidth}
                              height={metrics.keyHeight}
                              touchHeight={bottomRowTouch.touchHeight}
                              visualOffsetY={bottomRowTouch.visualOffsetY}
                              system
                              passive
                              active={isPressed("next-keyboard")}
                              onPress={() =>
                                runWithFeedback(() =>
                                  CustomKeyboard.nextKeyboard()
                                )}
                            />
                          )
                          : null}
                        <KeyFace
                          id="numbers"
                          label={symbolLayer ? "ABC" : "123"}
                          palette={palette}
                          width={showNextKeyboardButton
                            ? bottomSplitButtonWidth
                            : bottomNumbersWidth}
                          height={metrics.keyHeight}
                          touchHeight={bottomRowTouch.touchHeight}
                          visualOffsetY={bottomRowTouch.visualOffsetY}
                          system
                          selected={symbolLayer}
                          passive
                          active={isPressed("numbers")}
                          onPress={() => runWithFeedback(toggleSymbolLayer)}
                          onSwipeUp={() =>
                            runWithFeedback(() => pressSymbol("`"))}
                        />
                        <KeyFace
                          id="comma"
                          label=","
                          topCenter="."
                          topCenterForeground={palette.primary}
                          palette={palette}
                          width={bottomCommaWidth}
                          height={metrics.keyHeight}
                          touchHeight={bottomRowTouch.touchHeight}
                          visualOffsetY={bottomRowTouch.visualOffsetY}
                          passive
                          active={isPressed("comma")}
                          onPress={() => runWithFeedback(pressKeyboardComma)}
                          onSwipeUp={() => runWithFeedback(pressKeyboardPeriod)}
                        />
                        <KeyFace
                          id="space"
                          image="space"
                          bottomRight={settings.showWanxiangLabel
                            ? settings.spaceLabel
                            : undefined}
                          bottomRightFontSize={settings.spaceLabel.length > 4
                            ? 8
                            : settings.spaceLabel.length > 2
                            ? 10
                            : 12}
                          palette={palette}
                          width={bottomSpaceWidth}
                          height={metrics.keyHeight}
                          touchHeight={bottomRowTouch.touchHeight}
                          visualOffsetY={bottomRowTouch.visualOffsetY}
                          system
                          passive
                          active={isPressed("space")}
                          onPress={() => runWithFeedback(pressSpace)}
                          onSwipeUp={() =>
                            runWithFeedback(() => runT9SpaceSwipe("up"))}
                          onSwipeDown={() =>
                            runWithFeedback(() => runT9SpaceSwipe("down"))}
                          onSwipeLeft={() =>
                            runWithFeedback(() => moveCursorSafely(-1))}
                          onSwipeRight={() =>
                            runWithFeedback(() => moveCursorSafely(1))}
                        />
                        <KeyFace
                          id="mode"
                          image={composing && settings.modeComposingEnabled
                            ? settings.modeComposingIcon
                            : undefined}
                          modeTopLeft={composing &&
                              settings.modeComposingEnabled
                            ? undefined
                            : "中"}
                          modeBottomRight={composing &&
                              settings.modeComposingEnabled
                            ? undefined
                            : "英"}
                          modeTopLeftActive={!ascii}
                          palette={palette}
                          width={bottomModeWidth}
                          height={metrics.keyHeight}
                          touchHeight={bottomRowTouch.touchHeight}
                          visualOffsetY={bottomRowTouch.visualOffsetY}
                          system
                          passive
                          active={isPressed("mode")}
                          labelFontSize={18}
                          onPress={() =>
                            runWithFeedback(() =>
                              hitTargetActionsRef.current.pressMode()
                            )}
                          onSwipeUp={() =>
                            runWithFeedback(() => {
                              if (composing && settings.modeComposingEnabled) {
                                runConfiguredAction(
                                  settings.modeComposingSwipeUp,
                                  settings.modeComposingSwipeUpMode,
                                );
                              }
                            })}
                          onSwipeDown={() =>
                            runWithFeedback(() => {
                              if (composing && settings.modeComposingEnabled) {
                                runConfiguredAction(
                                  settings.modeComposingSwipeDown,
                                  settings.modeComposingSwipeDownMode,
                                );
                              }
                            })}
                          contextMenu={schemaMenu != null
                            ? { menuItems: schemaMenu }
                            : undefined}
                        />
                      </HStack>
                    </VStack>
                    <VStack
                      spacing={0}
                      frame={{
                        width: t9RightWidth,
                        height: t9PanelHeight + t9PanelTopInset +
                          t9PanelBottomInset + bottomRowTouch.touchHeight,
                        alignment: "topLeading" as any,
                      }}
                    >
                      {t9PanelTopInset > 0
                        ? (
                          <VStack
                            frame={{
                              width: t9RightWidth,
                              height: t9PanelTopInset,
                            }}
                          />
                        )
                        : null}
                      <KeyFace
                        id="t9-backspace"
                        image="delete.left"
                        palette={palette}
                        width={t9RightWidth}
                        height={metrics.keyHeight}
                        touchHeight={t9TouchFrame(0).touchHeight}
                        visualOffsetY={t9TouchFrame(0).visualOffsetY}
                        system
                        active={isPressed("t9-backspace")}
                        onPress={pressBackspace}
                        onTouchStart={() => beginKeyTouch("t9-backspace")}
                        onTouchEnd={() => endKeyTouch("t9-backspace")}
                        onLongPress={() => {
                          holdKeyPressedUntilRelease("t9-backspace");
                          startRepeatingBackspace("t9-backspace");
                        }}
                        onLongPressEnd={stopRepeatingBackspace}
                        onLongPressMove={backspaceLongPressMove}
                        longPressDuration={DELETE_LONG_PRESS_DURATION}
                        onSwipeLeft={backspaceSwipeLeft}
                        onSwipeUp={backspaceSwipeUp}
                        onSwipeDown={backspaceSwipeDown}
                        onSwipeStart={stopRepeatingBackspace}
                        swipeTriggerDistance={currentSwipeTriggerDistance}
                      />
                      <KeyFace
                        id="t9-delimiter"
                        label="'"
                        palette={palette}
                        width={t9RightWidth}
                        height={metrics.keyHeight}
                        touchHeight={t9TouchFrame(1).touchHeight}
                        visualOffsetY={t9TouchFrame(1).visualOffsetY}
                        active={isPressed("t9-delimiter")}
                        onPress={pressT9Delimiter}
                        onTouchStart={() => beginKeyTouch("t9-delimiter")}
                        onTouchEnd={() => endKeyTouch("t9-delimiter")}
                      />
                      <KeyFace
                        id="t9-enter"
                        image="paperplane.fill"
                        palette={palette}
                        width={t9RightWidth}
                        height={t9EnterOverlayHeight}
                        touchHeight={t9TouchFrame(2).touchHeight +
                          t9PanelBottomInset + bottomRowTouch.touchHeight}
                        visualOffsetY={t9TouchFrame(2).visualOffsetY}
                        system
                        active={isPressed("t9-enter")}
                        onPress={pressReturn}
                        onTouchStart={() => beginKeyTouch("t9-enter")}
                        onTouchEnd={() => endKeyTouch("t9-enter")}
                        onSwipeUp={insertNewline}
                        swipeTriggerDistance={currentSwipeTriggerDistance}
                      />
                    </VStack>
                  </HStack>
                )
                : (
                  <Group>
                    {cachedQwertyUpperRows}
                    {cachedQwertyBottomLetterRow}
                  </Group>
                )}
            </Group>

            {cachedQwertyBottomRow}
          </VStack>

          {candidateExpanded
            ? (
              <ExpandedCandidatePanel
                controller={rimeViewStateControllerRef.current!}
                settings={settings}
                metrics={metrics}
                palette={palette}
                panelHeight={expandedPanelHeight}
                expandedCandidates={expandedCandidates}
                batchHasMore={expandedBatchHasMore}
                candidateMenuActions={candidateMenuActions}
                onCandidateAction={onCandidateMenuAction}
                onSelectCandidate={onSelectExpandedCandidate}
                onMovePage={onMoveExpandedCandidatePage}
              />
            )
            : null}
        </ZStack>
      </VStack>
      {translateLangOpen
        ? (
          <TranslateLangPickerSurface
            activeId={getTranslateTargetLangId()}
            onPick={handleTranslateLangPick}
            onClose={() => setTranslateLangOpen(false)}
          />
        )
        : null}
      {punctPanelOpen
        ? (
          <PunctSurface
            onInsert={(sym) =>
              Thread.runInMain(() => insertTextReplacingSelectAll(sym))}
            onClose={() => setPunctPanelOpen(false)}
          />
        )
        : null}
      </ZStack>
    </KeyPressVisualContext.Provider>
  );
}

function main() {
  const settings = loadRimeKeyboardSettings();
  try {
    CustomKeyboard.setToolbarVisible(false);
  } catch {}
  try {
    const keyboard = CustomKeyboard as any;
    if (typeof keyboard.setHasDictationKey === "function") {
      keyboard.setHasDictationKey(false);
    } else keyboard.hasDictationKey = false;
  } catch {}
  if (settings.useCustomKeyboardHeight) {
    try {
      CustomKeyboard.requestHeight(settings.keyboardHeight);
    } catch {}
  }
  CustomKeyboard.present(<KeyboardView />);
}

main();
