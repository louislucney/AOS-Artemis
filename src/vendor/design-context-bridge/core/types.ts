export interface FigmaFill {
  type: string;
  color?: string;
  opacity: number;
}

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  opacity: number;
  fills: FigmaFill[];
  strokes: FigmaFill[];
  characters?: string;
  fontSize?: number | string;
  fontFamily?: string;
}

export interface FigmaTreeNode {
  id: string;
  name: string;
  type: string;
  fills?: FigmaFill[];
  characters?: string;
  fontSize?: number | string;
  fontFamily?: string;
  children?: FigmaTreeNode[];
}

export interface FigmaPageSummary {
  id: string;
  name: string;
  childCount: number;
}

export interface FigmaComponentDef {
  id: string;
  name: string;
  type: string;
  description: string;
}

export interface FigmaPageInfo {
  id: string;
  name: string;
  childCount: number;
  tree: FigmaTreeNode[];
}

export interface FigmaColorToken {
  hex: string;
  opacity: number;
  usedBy: string[];
}

export interface FigmaTextItem {
  id: string;
  name: string;
  characters: string;
  fontSize: number | string;
  fontFamily: string;
  fontStyle?: string;
}

export interface FigmaSpacingItem {
  name: string;
  layoutMode: string;
  itemSpacing: number;
  padding: { top: number; right: number; bottom: number; left: number };
  tokens: Record<string, string>;
}

export interface FigmaInteraction {
  id: string;
  name: string;
  type: string;
  reactions: unknown[];
}

export interface FigmaVariable {
  id: string;
  name: string;
  type: string;
  collection: string;
  valuesByMode: Record<string, unknown>;
}

export interface FigmaDocumentContext {
  selection: { nodes: FigmaNode[]; count: number; timestamp: number };
  selectedColors: FigmaColorToken[];
  selectedTexts: FigmaTextItem[];
  selectedSpacing: FigmaSpacingItem[];
  selectedInteractions: FigmaInteraction[];
  currentPage: FigmaPageInfo;
  pages: FigmaPageSummary[];
  components: FigmaComponentDef[];
  variables: FigmaVariable[];
  timestamp: number;
}

export type BridgeMessageType = 'context-update';

export interface BridgeMessage {
  type: BridgeMessageType;
  payload: FigmaDocumentContext;
}
