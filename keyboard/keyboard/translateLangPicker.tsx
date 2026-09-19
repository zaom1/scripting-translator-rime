import {
  Button,
  HStack,
  Image,
  ScrollView,
  Spacer,
  Text,
  VStack,
  ZStack,
} from "scripting";
import { TRANSLATE_LANG_OPTIONS } from "./translateLangStore";

// 键盘内「翻译目标语言」浮层：固定短列表，懒挂载（关闭即卸载），不进每帧路径。
export function TranslateLangPickerSurface(props: {
  activeId: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <ZStack
      frame={{
        maxWidth: "infinity" as any,
        maxHeight: "infinity" as any,
        alignment: "top" as any,
      }}
    >
      <Button action={() => props.onClose()}>
        <ZStack
          frame={{ maxWidth: "infinity" as any, maxHeight: "infinity" as any }}
          background={"rgba(0,0,0,0.35)" as any}
        />
      </Button>

      <VStack
        alignment="leading"
        spacing={8}
        padding={12}
        frame={{
          maxWidth: "infinity" as any,
          maxHeight: 300,
          alignment: "top" as any,
        }}
        background={"rgba(0,0,0,0.001)" as any}
        glassEffect={{ type: "rect", cornerRadius: 14 } as any}
        clipShape={{ type: "rect", cornerRadius: 14 }}
      >
        <HStack spacing={8} frame={{ maxWidth: "infinity" as any }}>
          <Image systemName="globe" font="body" />
          <Text font="headline">翻译目标语言</Text>
          <Spacer />
          <Button action={() => props.onClose()}>
            <Image systemName="xmark.circle.fill" font="body" />
          </Button>
        </HStack>

        <ScrollView
          axes="vertical"
          frame={{ maxWidth: "infinity" as any, maxHeight: 230 }}
        >
          <VStack alignment="leading" spacing={2}>
            {TRANSLATE_LANG_OPTIONS.map((option) => {
              const isActive = option.id === props.activeId;
              return (
                <Button
                  key={option.id}
                  action={() => props.onPick(option.id)}
                >
                  <HStack
                    spacing={8}
                    frame={{
                      maxWidth: "infinity" as any,
                      alignment: "leading" as any,
                    }}
                  >
                    <Image
                      systemName={isActive ? "largecircle.fill.circle" : "circle"}
                      font="body"
                      foregroundStyle={isActive ? "tintColor" : "secondaryLabel"}
                    />
                    <Text font="body">{option.label}</Text>
                    <Spacer />
                  </HStack>
                </Button>
              );
            })}
          </VStack>
        </ScrollView>
      </VStack>
    </ZStack>
  );
}
