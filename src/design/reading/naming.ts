export interface ReadingNamingStyle {
  separators?: string[];
  stateKeywords?: string[];
  synonyms?: Record<string, string[]>;
}

export interface StateLabelSplit {
  label: string;
  state: string | null;
  separator: string | null;
}

export const DEFAULT_STATE_SEPARATORS = [
  "-",
  "–",
  "—",
  "－",
  "/",
  "／",
  "｜",
  "|",
  "_",
  "·",
  "・",
  ":",
  "：",
  "(",
  "（",
  "[",
  "【",
  "→",
  ">",
  "»"
];

export const DEFAULT_STATE_KEYWORDS = [
  "下滑",
  "上滑",
  "下拉",
  "上拉",
  "展开",
  "展開",
  "收起",
  "折叠",
  "摺疊",
  "弹窗",
  "彈窗",
  "弹层",
  "彈層",
  "空态",
  "空態",
  "错误",
  "錯誤",
  "加载",
  "加載",
  "成功",
  "失败",
  "失敗",
  "默认",
  "默認",
  "选中",
  "選中",
  "已选",
  "已選",
  "未选",
  "未選",
  "内用",
  "內用",
  "外带",
  "外帶",
  "外送",
  "自取",
  "店外",
  "车道",
  "車道",
  "scrolled",
  "scroll",
  "expanded",
  "collapsed",
  "open",
  "closed",
  "empty",
  "error",
  "loading",
  "success",
  "default",
  "selected",
  "unselected",
  "active",
  "inactive",
  "disabled",
  "enabled",
  "hover",
  "pressed",
  "focus",
  "dark",
  "light",
  "modal",
  "sheet",
  "popup",
  "dialog",
  "variant",
  "v2",
  "v3"
];

export const DEFAULT_SYNONYMS: Record<string, string[]> = {
  search: ["搜尋", "搜索", "search", "検索", "검색"],
  store: ["門市", "门市", "门店", "store", "店舗", "매장"],
  cart: ["購物袋", "购物袋", "购物车", "cart", "bag", "カート", "장바구니"],
  checkout: ["結帳", "结账", "checkout", "pay", "支払", "결제"],
  order: ["訂單", "订单", "order", "注文", "주문"],
  pickup: ["取餐", "pickup", "受け取り", "픽업"],
  back: ["返回", "back", "戻る", "뒤로"],
  tab: ["分頁", "分页", "tab", "タブ", "탭"],
  confirm: ["確認", "确认", "confirm", "確認する"],
  cancel: ["取消", "cancel", "キャンセル", "취소"],
  close: ["關閉", "关闭", "close", "閉じる", "닫기"],
  open: ["開啟", "开启", "open", "開く", "열기"],
  sheet: [
    "彈層",
    "弹层",
    "底部弹层",
    "底部彈層",
    "bottom sheet",
    "sheet",
    "モーダル",
    "바텀시트"
  ],
  boardlabel: [
    "手機外框上方",
    "手機外框頂部",
    "手机外框上方",
    "画板标签",
    "畫板標籤",
    "board label",
    "frame label",
    "画板名",
    "畫板名"
  ]
};

const TRAD_TO_SIMP_PAIRS =
  "門门 訂订 單单 確确 認认 結结 帳账 電电 話话 狀状 態态 選选 擇择 時时 間间 據据 顯显 圖图 標标 籤签 彈弹 層层 開开 關关 閉闭 這这 個个 為为 與与 將将 沒没 過过 進进 來来 頁页 畫画 錯错 誤误 載载 預预 設设 備备 註注 記记 錄录 詢询 價价 錢钱 數数 總总 額额 付付 款款 取取 餐餐 市市 店店 內内 用用 外外 帶带 送送 車车 道道 樓楼 梯梯 手手 機机 號号 碼码 資资 訊讯 項项 目目 容容 片片 文文 字字 按按 鈕钮 完完 成成 面面 對对 話话 框框 收收 合合 展展 滑滑 上上 下下 左左 右右 點点 間间 門门 選选 擇择 時时 確确 認认 結结 帳账 訂订 單单 狀状 態态 頁页 面面 彈弹 出出 對对 話话 框框 關关 閉闭 開开 啟启 收收 合合 展展 開开 滑滑 動动 載载 入入 錯错 誤误 空空 態态 預预 設设 選选 中中 已已 選选 未未 選选 內内 用用 外外 帶带 外外 送送 自自 取取 店店 外外 車车 道道";

const TRAD_TO_SIMP = new Map<string, string>();
for (const pair of TRAD_TO_SIMP_PAIRS.split(" ")) {
  const chars = [...pair];
  if (chars.length === 2 && chars[0] !== chars[1]) {
    TRAD_TO_SIMP.set(chars[0]!, chars[1]!);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 匹配用归一：NFKC、常见繁转简、去标点/空白、小写。不是完整繁简转换。 */
export function normalizeMatchText(value: string): string {
  const text = value
    .normalize("NFKC")
    .toLowerCase()
    .split("")
    .map((char) => TRAD_TO_SIMP.get(char) ?? char)
    .join("");
  return text.replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function canonicalizeMatch(
  value: string,
  synonyms: Record<string, string[]> = {}
): string {
  const merged: Record<string, string[]> = { ...DEFAULT_SYNONYMS };
  for (const [canonical, aliases] of Object.entries(synonyms)) {
    merged[canonical] = [...(merged[canonical] ?? []), ...aliases];
  }
  const entries = Object.entries(merged)
    .flatMap(([canonical, aliases]) =>
      [canonical, ...aliases].map((alias) => ({
        canonical: normalizeMatchText(canonical),
        text: normalizeMatchText(alias)
      }))
    )
    .filter((entry) => entry.text !== "" && entry.text !== entry.canonical)
    .sort((left, right) => right.text.length - left.text.length);
  let text = normalizeMatchText(value);
  for (const entry of entries) {
    text = text.split(entry.text).join(entry.canonical);
  }
  return text;
}

export function isStateKeyword(
  value: string,
  style: ReadingNamingStyle = {}
): boolean {
  const normalized = normalizeMatchText(value);
  if (normalized === "") return false;
  const keywords = new Set(
    [...DEFAULT_STATE_KEYWORDS, ...(style.stateKeywords ?? [])].map((keyword) =>
      normalizeMatchText(keyword)
    )
  );
  return keywords.has(normalized);
}

export function isGenericLabel(value: string | null | undefined): boolean {
  if (typeof value !== "string") return true;
  const text = value.normalize("NFKC").trim();
  if (text === "" || /^\d+$/.test(text)) return true;
  return /^(frame|screen|group|layer|text|rectangle|container|artboard|board|panel|view|page|画板|屏幕|分组|圖層|图层|矩形|容器|画布|页面)\s*[-_ ]?\s*\d*$/i.test(
    text
  );
}

function cleanStateSuffix(value: string): string {
  return value
    .trim()
    .replace(/^[)\]}】）]+/, "")
    .replace(/[)\]}】）]+$/, "")
    .replace(/[({【（]+$/, "")
    .trim();
}

export function splitStateLabel(
  label: string,
  parentName: string,
  style: ReadingNamingStyle = {}
): StateLabelSplit {
  const trimmed = label.trim();
  const result: StateLabelSplit = { label: trimmed, state: null, separator: null };
  if (trimmed === "") return result;
  const normalizedLabel = normalizeMatchText(trimmed);
  const normalizedParent = normalizeMatchText(parentName);
  if (normalizedLabel === normalizedParent) return result;

  const separators = [...new Set([...DEFAULT_STATE_SEPARATORS, ...(style.separators ?? [])])]
    .filter((separator) => separator !== "")
    .sort((left, right) => right.length - left.length);
  const keywords = [...new Set([...DEFAULT_STATE_KEYWORDS, ...(style.stateKeywords ?? [])])];
  const parentPattern = escapeRegExp(parentName.trim());

  for (const separator of separators) {
    const pattern = new RegExp(
      `^${parentPattern}\\s*${escapeRegExp(separator)}\\s*(.+?)\\s*$`,
      "i"
    );
    const match = pattern.exec(trimmed);
    if (match !== null) {
      const state = cleanStateSuffix(match[1] ?? "");
      if (state !== "" && normalizeMatchText(state) !== "") {
        return { label: trimmed, state, separator };
      }
    }
  }

  for (const separator of separators) {
    const pattern = new RegExp(
      `^(.+?)\\s*${escapeRegExp(separator)}\\s*${parentPattern}\\s*$`,
      "i"
    );
    const match = pattern.exec(trimmed);
    if (match !== null) {
      const state = cleanStateSuffix(match[1] ?? "");
      if (state !== "" && normalizeMatchText(state) !== "") {
        return { label: trimmed, state, separator };
      }
    }
  }

  const keywordSet = new Set(keywords.map((keyword) => normalizeMatchText(keyword)));
  if (keywordSet.has(normalizedLabel)) {
    return { label: trimmed, state: trimmed, separator: null };
  }
  if (normalizedLabel.startsWith(normalizedParent)) {
    const rest = trimmed.slice(parentName.trim().length).trim();
    if (rest !== "" && keywordSet.has(normalizeMatchText(rest))) {
      return { label: trimmed, state: rest, separator: null };
    }
  }
  return result;
}

export function sanitizeBoardLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  let text = value.trim().replace(/\s+/g, " ");
  if (text === "") return null;
  const labeled =
    /(?:畫框標籤|画框标签|畫板標籤|画板标签|board\s*label)\s*[:：]\s*(.+)$/i.exec(text);
  if (labeled?.[1]) text = labeled[1].trim();
  if (/[；;]/.test(text) || /[。\n]/.test(text)) return null;
  if (/(畫框|画框|畫布|画布|區塊|区块|標題|标题)/.test(text)) return null;
  text = text.replace(/^[「『"']+|[」』"']+$/g, "").trim();
  if (text === "" || text.length > 48 || isGenericLabel(text)) return null;
  return text;
}

export function stateLabelsOf(
  value: unknown,
  parentName: string,
  _style: ReadingNamingStyle = {}
): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = (entry as { label?: unknown }).label;
    if (typeof raw !== "string") continue;
    const label = raw.trim();
    if (label === "" || normalizeMatchText(label) === normalizeMatchText(parentName)) continue;
    const key = normalizeMatchText(label);
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  return labels;
}
