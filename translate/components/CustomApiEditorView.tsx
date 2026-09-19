import {
  Button,
  Form,
  Image,
  Navigation,
  NavigationStack,
  Picker,
  Section,
  Text,
  TextField,
  useState,
} from "scripting"
import type {
  CustomApiHttpMethod,
  TranslationEngineConfig,
} from "../types"

const PLACEHOLDER_HINT =
  "可用占位符：{{text}} 原文、{{sourceLang}} 源语言、{{targetLang}} 目标语言。"

export function CustomApiEditorView(props: {
  title: string
  note?: string
  initial?: Partial<TranslationEngineConfig> & { label?: string }
}) {
  const dismiss = Navigation.useDismiss()
  const [label, setLabel] = useState(String(props.initial?.label ?? "自定义接口"))
  const [httpMethod, setHttpMethod] = useState<CustomApiHttpMethod>(
    props.initial?.httpMethod === "POST" ? "POST" : "GET"
  )
  const [requestUrl, setRequestUrl] = useState(String(props.initial?.requestUrl ?? ""))
  const [requestHeaders, setRequestHeaders] = useState(String(props.initial?.requestHeaders ?? ""))
  const [requestBody, setRequestBody] = useState(String(props.initial?.requestBody ?? ""))
  const [responsePath, setResponsePath] = useState(String(props.initial?.responsePath ?? ""))
  const [langMap, setLangMap] = useState(String(props.initial?.langMap ?? ""))

  function save() {
    const normalizedUrl = requestUrl.trim()
    if (!normalizedUrl) {
      void Dialog.alert({
        title: "无法保存",
        message: "请先填写请求 URL。",
      })
      return
    }

    const config: TranslationEngineConfig = {
      httpMethod,
      requestUrl: normalizedUrl,
      requestHeaders: requestHeaders.trim(),
      requestBody: httpMethod === "POST" ? requestBody : "",
      responsePath: responsePath.trim(),
      langMap: langMap.trim(),
    }

    dismiss({
      config,
      label: label.trim() || "自定义接口",
      systemImage: "text.badge.plus",
    })
  }

  return (
    <NavigationStack>
      <Form
        navigationTitle={props.title}
        navigationBarTitleDisplayMode="inline"
        formStyle="grouped"
        toolbar={{
          topBarLeading: (
            <Button action={() => dismiss()}>
              <Image systemName="chevron.left" fontWeight="semibold" foregroundStyle="#007AFF" />
            </Button>
          ),
          topBarTrailing: (
            <Button
              title="保存"
              fontWeight="semibold"
              foregroundStyle="#007AFF"
              action={save}
            />
          ),
        }}
      >
        {props.note ? (
          <Section>
            <Text>{props.note}</Text>
          </Section>
        ) : null}

        <Section header={<Text>基础信息</Text>}>
          <TextField
            title="名称"
            value={label}
            onChanged={setLabel}
            prompt="例如 我的免费接口"
          />
          <Picker
            title="请求方法"
            value={httpMethod}
            onChanged={(value: CustomApiHttpMethod) => setHttpMethod(value)}
          >
            <Text tag="GET">GET</Text>
            <Text tag="POST">POST</Text>
          </Picker>
        </Section>

        <Section
          header={<Text>请求配置</Text>}
          footer={<Text>{PLACEHOLDER_HINT}</Text>}
        >
          <TextField
            title="请求 URL"
            value={requestUrl}
            onChanged={setRequestUrl}
            prompt="https://api.example.com/translate?text={{text}}"
            axis="vertical"
            frame={{ minHeight: 60, maxWidth: "infinity" as any, alignment: "topLeading" as any }}
          />
          <TextField
            title="请求头"
            value={requestHeaders}
            onChanged={setRequestHeaders}
            prompt={"每行一条，例如\nAuthorization: Bearer YOUR_KEY\nContent-Type: application/json"}
            axis="vertical"
            frame={{ minHeight: 60, maxWidth: "infinity" as any, alignment: "topLeading" as any }}
          />
          {httpMethod === "POST" ? (
            <TextField
              title="请求体"
              value={requestBody}
              onChanged={setRequestBody}
              prompt={'例如 {"q":"{{text}}","source":"{{sourceLang}}","target":"{{targetLang}}"}'}
              axis="vertical"
              frame={{ minHeight: 60, maxWidth: "infinity" as any, alignment: "topLeading" as any }}
            />
          ) : null}
        </Section>

        <Section
          header={<Text>响应解析</Text>}
          footer={
            <Text>
              译文提取路径用点号和下标定位 JSON 字段，例如 data.translations.0.text；留空则尝试自动识别。
            </Text>
          }
        >
          <TextField
            title="译文提取路径"
            value={responsePath}
            onChanged={setResponsePath}
            prompt="data.translations.0.text"
          />
          <TextField
            title="语言代码对照"
            value={langMap}
            onChanged={setLangMap}
            prompt={"每行一条 内部码=接口码，例如\nzh-Hans=zh-CN\nauto=auto"}
            axis="vertical"
            frame={{ minHeight: 60, maxWidth: "infinity" as any, alignment: "topLeading" as any }}
          />
        </Section>
      </Form>
    </NavigationStack>
  )
}
