// 键盘侧「翻译目标语言」持久化：脚本私有域存储，与翻译器/模型池解耦。
// 默认 "auto" 时保持原有中英互译自动判定行为，向后兼容。

export type TranslateLangOption = {
  id: string;
  label: string;
  name: string;
};

export const TRANSLATE_LANG_AUTO = "auto";

// name 用于喂给 AI 提示词的目标语言英文名。
export const TRANSLATE_LANG_OPTIONS: TranslateLangOption[] = [
  { id: "auto", label: "自动（中英互译）", name: "" },
  { id: "zh-CN", label: "简体中文", name: "Simplified Chinese" },
  { id: "zh-TW", label: "繁體中文", name: "Traditional Chinese" },
  { id: "en", label: "English", name: "English" },
  { id: "ja", label: "日本語", name: "Japanese" },
  { id: "ko", label: "한국어", name: "Korean" },
  { id: "fr", label: "Français", name: "French" },
  { id: "de", label: "Deutsch", name: "German" },
  { id: "es", label: "Español", name: "Spanish" },
  { id: "ru", label: "Русский", name: "Russian" },
  { id: "pt", label: "Português", name: "Portuguese" },
  { id: "it", label: "Italiano", name: "Italian" },
  { id: "ar", label: "العربية", name: "Arabic" },
  { id: "th", label: "ไทย", name: "Thai" },
  { id: "vi", label: "Tiếng Việt", name: "Vietnamese" },
];

const LANG_KEY = "kb_translate_lang_v1";

function storage(): any {
  return (globalThis as any).Storage;
}

export function getTranslateTargetLangId(): string {
  try {
    const value = storage()?.get?.(LANG_KEY);
    return typeof value === "string" && value ? value : TRANSLATE_LANG_AUTO;
  } catch {
    return TRANSLATE_LANG_AUTO;
  }
}

export function setTranslateTargetLangId(id: string) {
  try {
    const st = storage();
    if (!id || id === TRANSLATE_LANG_AUTO) st?.remove?.(LANG_KEY);
    else st?.set?.(LANG_KEY, id);
  } catch {}
}

export function translateLangLabel(id: string): string {
  if (!id || id === TRANSLATE_LANG_AUTO) {
    return TRANSLATE_LANG_OPTIONS[0].label;
  }
  return TRANSLATE_LANG_OPTIONS.find((item) => item.id === id)?.label ?? id;
}

export function translateLangName(id: string): string {
  return TRANSLATE_LANG_OPTIONS.find((item) => item.id === id)?.name ?? "";
}
