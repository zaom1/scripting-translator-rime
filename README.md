# Scripting 翻译器 & Rime 键盘

两个面向 iOS [Scripting](https://github.com/dmuy/Scripting) App 的脚本：**多引擎翻译器**与 **Rime 万象键盘**。本项目在开源作品基础上二次开发、深度重构而成，完整归属与许可见文末 [致谢](#致谢) 与 [许可证](#许可证)。

## 功能一览

### 翻译器（`translate/`）
- **多引擎并列**：一次翻译同时跑所有已启用的引擎，每个引擎一张卡片，可逐卡重译。
- 内置引擎：System Translate、Apple Intelligence、Scripting Assistant、Google 网页翻译。
- 外部引擎：可配置 **AI 接口**（OpenAI 兼容，支持 `/v1/models` 实时拉取并展开模型）、DeepLX、自定义 HTTP 接口。
- **「AI 翻译」引擎**：在设置页开关控制；模型选择栏列出**整个模型池**（任意供应商 × 任意模型），选谁用谁。
- **逐卡选模型**：每个 AI 接口卡可在**本供应商范围内**切换模型，互不干扰。
- 可设为**系统默认翻译**：在 Safari / 其它 App 里调用时，与翻译器页面行为一致（多引擎 + 内置选模型）。
- 源语言自动检测、复制 / 替换原文、长按重译等交互。

### Rime 键盘（`keyboard/`）
- 基于 **Rime** 引擎的第三方键盘，万象风格界面。
- 支持全键盘与**九宫格（T9）拼音**，含候选、标点符号面板等。
- 键盘顶部可内联切换 AI 模型，支持取词翻译与 AI 回复。
- 词库 / 方案 / Lua（含 T9 processor）可配置。

## 导入方式

在 Scripting App 里选择 **从 URL 导入（New Script → Import from URL）**，复制下面的链接即可。

> 注意：本仓库是**翻译器 + 键盘的多脚本合仓**，根目录没有统一的 `script.json`，因此请使用下面的**子目录链接**分别导入，不要用整仓 zip。

**翻译器：**
```
https://github.com/zaom1/scripting-translator-rime/tree/main/translate
```

**Rime 键盘：**
```
https://github.com/zaom1/scripting-translator-rime/tree/main/keyboard
```

如已导入过同名脚本，重新按子目录导入 / 运行会自动拉取 `main` 分支最新内容。

## 致谢

本项目 derived 自以下优秀的开源作品，谨此向原作者致敬：

- **[expoli](https://github.com/expoli)** —— 原始代码的版权作者（见 [LICENSE](./LICENSE) 中的 `Copyright (c) 2025 expoli`）。
- **[BlackCCCat / Scripting-Scripts](https://github.com/BlackCCCat/Scripting-Scripts)** —— 本项目的取用来源仓库。
- **[imfuxiao / Hamster](https://github.com/imfuxiao/Hamster)** —— Rime 键盘实现的重要参考。

## 许可证

本项目以 **MIT License** 发布，详见 [LICENSE](./LICENSE)。其中保留了原始版权声明 `Copyright (c) 2025 expoli`，二次开发部分在其条款下分发。
