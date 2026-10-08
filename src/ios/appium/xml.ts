import { XMLParser, XMLValidator } from "fast-xml-parser";

import type { IosUiNode } from "../../device/ios.js";

const ELEMENT_TAG_RE = /^XCUIElementType(.+)$/;
const ATTR_PREFIX = "@_";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function attrText(element: Record<string, unknown>, name: string): string {
  const value = element[`${ATTR_PREFIX}${name}`];
  return typeof value === "string" ? value : "";
}

function attrNumber(element: Record<string, unknown>, name: string): number | null {
  const value = element[`${ATTR_PREFIX}${name}`];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function nodeFromElement(type: string, value: unknown): IosUiNode | null {
  const element = asRecord(value);
  if (element === null) return null;
  const x = attrNumber(element, "x");
  const y = attrNumber(element, "y");
  const width = attrNumber(element, "width");
  const height = attrNumber(element, "height");
  if (x === null || y === null || width === null || height === null) return null;
  const identifier = attrText(element, "identifier");
  const name = attrText(element, "name");
  return {
    type,
    label: attrText(element, "label"),
    value: attrText(element, "value"),
    id: identifier !== "" ? identifier : name,
    rect: { x, y, width, height }
  };
}

/** Convert a WebDriverAgent page source XML into the flat IosUiNode list that
 * the idb path produces (depth-first pre-order, geometry-bearing elements only). */
export function parsePageSource(xml: string): IosUiNode[] | null {
  if (typeof xml !== "string" || xml.trim() === "") return null;
  if (XMLValidator.validate(xml) !== true) return null;
  let doc: unknown;
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: ATTR_PREFIX,
      parseAttributeValue: false,
      trimValues: true
    });
    doc = parser.parse(xml);
  } catch {
    return null;
  }
  const root = asRecord(doc);
  if (root === null) return null;

  const nodes: IosUiNode[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = asRecord(value);
    if (record === null) return;
    for (const [key, child] of Object.entries(record)) {
      const match = ELEMENT_TAG_RE.exec(key);
      if (match === null) {
        visit(child);
        continue;
      }
      const items = Array.isArray(child) ? child : [child];
      for (const item of items) {
        const node = nodeFromElement(match[1]!, item);
        if (node !== null) nodes.push(node);
        visit(item);
      }
    }
  };
  visit(root);
  return nodes;
}
