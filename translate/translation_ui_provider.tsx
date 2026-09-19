import { TranslationPanel } from "./components/TranslationPanel"
import { getTranslationSessionSnapshot, presentTranslationUI } from "./utils/translation_session"

const session = getTranslationSessionSnapshot()

presentTranslationUI(
  // 作为系统默认翻译时与翻译器页面一致：多引擎并列（所有已启用的引擎），
  // 并在卡片内置“AI 翻译”整池选模型 + 每个 AI 接口卡的本供应商选模型。
  <TranslationPanel
    inputText={session.inputText}
    allowsReplacement={session.allowsReplacement}
  />
)
