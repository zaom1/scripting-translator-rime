import {
  Button,
  HStack,
  ScrollView,
  Spacer,
  Text,
  VStack,
  ZStack,
  useState,
} from "scripting";

// 中英标点符号面板（万象风格超集）：浮层内直接摆出真实标点，点哪个就往对话框插入哪个。
// 中文/英文分两个标签页。脚本运行时读不到万象方案的 symbol 词库，故为手工整理的常用大全集。
const CN_PUNCT: string[] = [
  "，", "。", "、", "；", "：", "？", "！", "·",
  "（", "）", "「", "」", "『", "』", "【", "】",
  "〔", "〕", "〈", "〉", "《", "》", "“", "”",
  "‘", "’", "—", "…", "～", "＿", "￥", "＄",
  "℃", "°", "％", "＃", "＆", "＿", "±", "×",
  "÷", "＝", "≠", "≈", "≤", "≥", "∞", "§",
  "※", "→", "←", "↑", "↓", "①", "②", "③",
  "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩",
];
const EN_PUNCT: string[] = [
  ",", ".", ";", ":", "?", "!", "'", "\"",
  "(", "[", "{", "<", ")", "]", "}", ">",
  "/", "\\", "|", "_", "-", "+", "=", "*",
  "@", "#", "%", "&", "~", "^", "$", "`",
  "€", "£", "¥", "¢", "§", "¶", "†", "‡",
  "•", "·", "…", "—", "–", "×", "÷", "±",
  "°", "©", "®", "™", "µ", "∞", "≠", "≈",
];
const PER_ROW = 7;

function chunkRows(symbols: string[]): string[][] {
  const rows: string[][] = [];
  for (let i = 0; i < symbols.length; i += PER_ROW) {
    rows.push(symbols.slice(i, i + PER_ROW));
  }
  return rows;
}

export function PunctSurface(props: {
  onInsert: (symbol: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"cn" | "en">("cn");
  const symbols = tab === "cn" ? CN_PUNCT : EN_PUNCT;
  const rows = chunkRows(symbols);

  return (
    <ZStack
      frame={{
        maxWidth: "infinity" as any,
        maxHeight: "infinity" as any,
        alignment: "top" as any,
      }}
    >
      {/* 点遮罩区域关闭面板 */}
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
          maxHeight: 340,
          alignment: "top" as any,
        }}
        background={"rgba(0,0,0,0.001)" as any}
        glassEffect={{ type: "rect", cornerRadius: 14 } as any}
        clipShape={{ type: "rect", cornerRadius: 14 }}
      >
        <HStack spacing={8} frame={{ maxWidth: "infinity" as any }}>
          <Text font="headline">中英符号</Text>
          <Spacer />
          <Button action={() => setTab("cn")}>
            <Text
              font="body"
              foregroundStyle={tab === "cn" ? "tintColor" : "secondaryLabel"}
            >
              中文
            </Text>
          </Button>
          <Button action={() => setTab("en")}>
            <Text
              font="body"
              foregroundStyle={tab === "en" ? "tintColor" : "secondaryLabel"}
            >
              英文
            </Text>
          </Button>
          <Button action={() => props.onClose()}>
            <Text font="body" foregroundStyle="secondaryLabel">
              完成
            </Text>
          </Button>
        </HStack>

        <ScrollView
          axes="vertical"
          frame={{ maxWidth: "infinity" as any, maxHeight: 268 }}
        >
          <VStack alignment="leading" spacing={6}>
            {rows.map((row, rowIndex) => (
              <HStack key={`prow-${rowIndex}`} spacing={6}>
                {row.map((sym) => (
                  <Button key={`psym-${rowIndex}-${sym}`} action={() => props.onInsert(sym)}>
                    <Text
                      font="body"
                      frame={{ width: 40, height: 38, alignment: "center" as any }}
                      background={"rgba(120,120,128,0.16)" as any}
                      clipShape={{ type: "rect", cornerRadius: 8 }}
                    >
                      {sym}
                    </Text>
                  </Button>
                ))}
              </HStack>
            ))}
          </VStack>
        </ScrollView>
      </VStack>
    </ZStack>
  );
}
