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

// 键盘内模型选择：打开时占据「CandidateHeader + 功能键行」两行的垂直空间
// （约 90px），竖排布局——顶部搜索状态行 + 下方大字体可滚动列表。
// QWERTY 三行字母键完全不被遮挡，用户点击字母键即可搜索过滤模型。
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
      {/* 顶部：搜索状态 + 清空/关闭 */}
      <HStack spacing={6} frame={{ width: "100%" as any }}>
        <Image systemName="brain.head.profile" font="subheadline" />
        <Text
          font="subheadline"
          foregroundStyle={props.query ? "primary" : "secondaryLabel"}
          lineLimit={1}
          truncationMode="tail"
          frame={{ maxWidth: "infinity" as any, alignment: "leading" as any }}
        >
          {props.query
            ? `搜索“${props.query}”`
            : "选模型 · 用下方字母键输入过滤"}
        </Text>
        {props.query
          ? (
            <Button action={() => props.onClearQuery()}>
              <Text font="subheadline" foregroundStyle="tintColor">清空</Text>
            </Button>
          )
          : null}
        <Button action={() => props.onClose()}>
          <Image systemName="xmark.circle.fill" font="subheadline" />
        </Button>
      </HStack>

      {/* 下方：大字体可滚动模型列表 */}
      {visible.length === 0
        ? (
          <Text font="subheadline" foregroundStyle="secondaryLabel" lineLimit={2}>
            {props.query ? "没有匹配的模型。" : "模型池为空，请先在翻译器添加 AI 接口。"}
          </Text>
        )
        : (
          <ScrollView
            axes="vertical"
            frame={{ width: "100%" as any, maxHeight: "infinity" as any }}
          >
            <VStack alignment="leading" spacing={4}>
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
                        font="body"
                        foregroundStyle={
                          isActive ? "tintColor" : "secondaryLabel"
                        }
                      />
                      <Text
                        font="body"
                        foregroundStyle={usable ? "primary" : "secondaryLabel"}
                        lineLimit={1}
                        truncationMode="tail"
                      >
                        {modelEntryLabel(entry) || entry.id}
                      </Text>
                      <Spacer />
                      {!usable
                        ? (
                          <Text font="caption" foregroundStyle="secondaryLabel">
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
