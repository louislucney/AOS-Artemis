export interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

export function asAdfNode(value: unknown): AdfNode | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as AdfNode;
}

function attrText(node: AdfNode, key: string): string | null {
  const value = node.attrs?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function children(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? node.content : [];
}

function render(node: AdfNode): string {
  switch (node.type) {
    case "text":
      return node.text ?? "";
    case "hardBreak":
      return "\n";
    case "mention":
      return attrText(node, "text") ?? "";
    case "emoji":
      return attrText(node, "text") ?? attrText(node, "shortName") ?? "";
    case "inlineCard":
      return attrText(node, "url") ?? "";
    case "media":
      return attrText(node, "alt") ?? "[media]";
    case "mediaSingle":
    case "mediaGroup":
      return children(node).map(render).join("\n");
    case "rule":
      return "\n---\n";
    case "listItem":
      return children(node).map(render).join("\n").trim() + "\n";
    case "bulletList":
      return (
        children(node)
          .map((item) => `- ${render(item).trim()}`)
          .join("\n") + "\n"
      );
    case "orderedList":
      return (
        children(node)
          .map((item, index) => `${index + 1}. ${render(item).trim()}`)
          .join("\n") + "\n"
      );
    case "tableRow":
      return (
        children(node)
          .map((cell) => render(cell).trim())
          .join(" | ") + "\n"
      );
    case "paragraph":
    case "heading":
    case "codeBlock":
    case "blockquote":
    case "panel":
    case "tableCell":
    case "tableHeader":
      return children(node).map(render).join("") + "\n";
    default:
      return children(node).map(render).join("");
  }
}

/** Flatten Atlassian Document Format into plain text (best-effort, lossy by design). */
export function adfToText(value: unknown): string {
  const node = asAdfNode(value);
  if (node === null) return "";
  return render(node)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
