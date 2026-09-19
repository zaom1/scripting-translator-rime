import {
  Button,
  HStack,
  Image,
  ScrollView,
  Spacer,
  Text,
  VStack,
  useMemo,
  useState,
} from "scripting";
import {
  type AiModelPoolEntry,
  filterEntries,
  isModelUsableInKeyboard,
  listSortedForPicker,
  modelEntryLabel,
} from "./aiModelStore";

// 键盘内模型选择：作为键盘“顶部新增一行”内联渲染（不是遮罩浮层），
// main.tsx 打开它时把键盘整体加高、并预留该高度让字母键尺寸不变，
// 因此第一/二行与 QWERTY 都不被遮挡。搜索仍靠键盘自身字母/空格/退格喂 query。
export function ModelPickerSurface(props: {
  height: number;
  activeLabel?: string;
  query: string;
  onClearQuery: () => void;
  onPick: (entry: AiModelPoolEntry | null) => void;
  onClose: () => void;
}) {
  const [snapshot] = useState(() => listSortedForPicker());
  const activeId = snapshot.activeId;

  const visible = useMemo(
    () => filterEntries(snapshot.entries, props.query),
    [snapshot.entries, props.query],
  );

  return (
    <VStack
      alignment="leading"
      spacing={4}
      padding={{ horizontal: 10, vertical: 6 }}
      frame={{
        width: "100%" as any,
        height: props.height,
        alignment: "top" as any,
      }}
      background={"rgba(0,0,0,0.001)" as any}
      glassEffect={{ type: "rect", cornerRadius: 12 } as any}
      clipShape={{ type: "rect", cornerRadius: 12 }}
    >
      <HStack spacing={6} frame={{ width: "100%" as any }}>
        <Image systemName="brain.head.profile" font="caption" />
        <Text
          font="caption"
          foregroundStyle={props.query ? "primary" : "secondaryLabel"}
          lineLimit={1}
          frame={{ maxWidth: "infinity" as any, alignment: "leading" as any }}
        >
          {props.query
            ? `搜索“${props.query}”`
            : "选模型 · 用下方键盘输入字母/数字过滤…"}
        </Text>
        {props.query
          ? (
            <Button action={() => props.onClearQuery()}>
              <Text font="caption" foregroundStyle="tintColor">清空</Text>
            </Button>
          )
          : null}
        <Button action={() => props.onClose()}>
          <Image systemName="xmark.circle.fill" font="caption" />
        </Button>
      </HStack>

      {visible.length === 0
        ? (
          <Text font="footnote" foregroundStyle="secondaryLabel" lineLimit={2}>
            {props.query
              ? "没有匹配的模型，换个关键字或清空。"
              : "模型池为空。请先在翻译器设置里添加 AI 接口；仅 ai_api 模型可在键盘内直接调用。"}
          </Text>
        )
        : (
          <ScrollView
            axes="vertical"
            frame={{ width: "100%" as any, maxHeight: "infinity" as any }}
          >
            <VStack alignment="leading" spacing={2}>
              {visible.map((entry) => {
                const usable = isModelUsableInKeyboard(entry);
                const isActive = entry.id === activeId;
                return (
                  <Button
                    key={entry.id}
                    action={() => {
                      if (!usable) return;
                      props.onPick(entry);
                    }}
                  >
                    <HStack
                      spacing={8}
                      frame={{
                        width: "100%" as any,
                        alignment: "leading" as any,
                      }}
                    >
                      <Image
                        systemName={
                          isActive ? "largecircle.fill.circle" : "circle"
                        }
                        font="subheadline"
                        foregroundStyle={
                          isActive ? "tintColor" : "secondaryLabel"
                        }
                      />
                      <Text
                        font="subheadline"
                        foregroundStyle={usable ? "primary" : "secondaryLabel"}
                        lineLimit={1}
                        truncationMode="tail"
                      >
                        {modelEntryLabel(entry) || entry.id}
                      </Text>
                      <Spacer />
                      {!usable
                        ? (
                          <Text font="caption2" foregroundStyle="secondaryLabel">
                            不可用
                          </Text>
                        )
                        : null}
                    </HStack>
                  </Button>
                );
              })}
            </VStack>
          </ScrollView>
        )}
    </VStack>
  );
}
