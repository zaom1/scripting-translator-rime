import {
  Button,
  HStack,
  ScrollView,
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

// 键盘内模型选择：替换功能键行位置渲染，高度约 functionKeyHeight+8，
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
    <HStack
      spacing={2}
      padding={{ horizontal: 4, vertical: 1 }}
      frame={{
        width: "100%" as any,
        height: props.height,
        alignment: "leading" as any,
      }}
      background={"rgba(0,0,0,0.001)" as any}
      glassEffect={{ type: "rect", cornerRadius: 6 } as any}
      clipShape={{ type: "rect", cornerRadius: 6 }}
    >
      {/* 左侧：搜索状态 + 操作按钮 */}
      <VStack
        alignment="leading"
        spacing={0}
        frame={{ width: 68, alignment: "top" as any }}
      >
        <Text
          font={"caption2" as any}
          foregroundStyle={props.query ? "primary" : "secondaryLabel"}
          lineLimit={2}
        >
          {props.query ? props.query : "搜索模型"}
        </Text>
        <HStack spacing={2}>
          {props.query
            ? (
              <Button action={() => props.onClearQuery()}>
                <Text font={"caption2" as any} foregroundStyle="tintColor">清</Text>
              </Button>
            )
            : null}
          <Button action={() => props.onClose()}>
            <Text font={"caption2" as any} foregroundStyle="secondaryLabel">✕</Text>
          </Button>
        </HStack>
      </VStack>

      {/* 右侧：模型列表（可滚动） */}
      {visible.length === 0
        ? (
          <Text font={"caption2" as any} foregroundStyle="secondaryLabel">
            无匹配
          </Text>
        )
        : (
          <ScrollView
            axes="vertical"
            frame={{ maxWidth: "infinity" as any, maxHeight: "infinity" as any }}
          >
            <VStack alignment="leading" spacing={0}>
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
                    <Text
                      font={"caption2" as any}
                      foregroundStyle={
                        isActive
                          ? "tintColor"
                          : (usable ? "primary" : "secondaryLabel")
                      }
                      lineLimit={1}
                      truncationMode="tail"
                    >
                      {isActive ? "●" : "○"} {modelEntryLabel(entry) || entry.id}
                      {!usable ? " ×" : ""}
                    </Text>
                  </Button>
                );
              })}
            </VStack>
          </ScrollView>
        )}
    </HStack>
  );
}
