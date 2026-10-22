/** 设计/源码标识名 → a11y 标识（保守：显式前缀 / snake/kebab/dot/colon / lowerCamel；
 * 人类标签（含空格、纯单词、中文）不猜）。 */

const IDENTIFIER_PREFIX_RE =
  /^(?:testID|testId|accessibilityIdentifier|contentDescription|a11y|id)\s*[:=]\s*(.+)$/i;

export function identifierFromLayerName(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const prefixed = IDENTIFIER_PREFIX_RE.exec(trimmed);
  const candidate = (prefixed?.[1] ?? trimmed).trim();
  if (candidate === "" || /\s/.test(candidate)) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(candidate)) return null;
  const hasSeparator = /[_.:-]/.test(candidate);
  const lowerCamel = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/.test(candidate);
  return prefixed !== null || hasSeparator || lowerCamel ? candidate : null;
}
