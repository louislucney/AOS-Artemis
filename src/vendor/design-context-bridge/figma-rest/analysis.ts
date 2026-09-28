import type { FigmaNode } from './resolve.js';
import { walk } from './resolve.js';

/** Figma colors are 0..1 floats. Convert to #RRGGBB (+ alpha note when < 1). */
interface RGBA { r: number; g: number; b: number; a?: number }

function channel(n: number): string {
  return Math.round(n * 255).toString(16).padStart(2, '0');
}

export function rgbaToHex(c: RGBA): string {
  return `#${channel(c.r)}${channel(c.g)}${channel(c.b)}`.toUpperCase();
}

interface Paint {
  type?: string;
  color?: RGBA;
  opacity?: number;
  visible?: boolean;
}

function solidHexes(paints: Paint[] | undefined): Array<{ hex: string; opacity: number }> {
  if (!Array.isArray(paints)) return [];
  return paints
    .filter((p) => p.type === 'SOLID' && p.color && p.visible !== false)
    .map((p) => ({ hex: rgbaToHex(p.color as RGBA), opacity: p.opacity ?? (p.color as RGBA).a ?? 1 }));
}

/**
 * Derive a design system from a node tree: colors, typography, spacing,
 * radii and shadows — what a developer would reverse-engineer by hand when
 * the designer didn't define tokens.
 */
export function extractDesignSystem(root: FigmaNode): unknown {
  const colors = new Map<string, { hex: string; count: number; samples: Set<string> }>();
  const type = new Map<string, { family: string; size: number; weight: number; lineHeight?: number; letterSpacing?: number; count: number }>();
  const spacing = new Map<number, number>();
  const radii = new Map<number, number>();
  const shadows = new Map<string, { type: string; color: string; x: number; y: number; blur: number; spread: number; count: number }>();

  walk(root, (n) => {
    // Colors — fills and strokes
    for (const { hex } of [...solidHexes(n.fills as Paint[]), ...solidHexes(n.strokes as Paint[])]) {
      const entry = colors.get(hex) ?? { hex, count: 0, samples: new Set<string>() };
      entry.count++;
      if (entry.samples.size < 5) entry.samples.add(n.name);
      colors.set(hex, entry);
    }

    // Typography — TEXT nodes
    if (n.type === 'TEXT' && n.style) {
      const s = n.style as Record<string, number | string>;
      const family = String(s.fontFamily ?? '');
      const size = Number(s.fontSize ?? 0);
      const weight = Number(s.fontWeight ?? 400);
      const key = `${family}|${size}|${weight}`;
      const entry = type.get(key) ?? {
        family, size, weight,
        lineHeight: s.lineHeightPx != null ? Number(s.lineHeightPx) : undefined,
        letterSpacing: s.letterSpacing != null ? Number(s.letterSpacing) : undefined,
        count: 0,
      };
      entry.count++;
      type.set(key, entry);
    }

    // Spacing — auto-layout gap and padding
    if (typeof n.itemSpacing === 'number' && n.itemSpacing > 0) {
      spacing.set(n.itemSpacing, (spacing.get(n.itemSpacing) ?? 0) + 1);
    }
    for (const key of ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'] as const) {
      const v = n[key];
      if (typeof v === 'number' && v > 0) spacing.set(v, (spacing.get(v) ?? 0) + 1);
    }

    // Corner radius
    if (typeof n.cornerRadius === 'number' && n.cornerRadius > 0) {
      radii.set(n.cornerRadius, (radii.get(n.cornerRadius) ?? 0) + 1);
    }

    // Shadows / effects
    if (Array.isArray(n.effects)) {
      for (const e of n.effects as Array<Record<string, unknown>>) {
        if ((e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') && e.visible !== false) {
          const offset = (e.offset as { x: number; y: number }) ?? { x: 0, y: 0 };
          const color = e.color ? rgbaToHex(e.color as RGBA) : '#000000';
          const key = `${e.type}|${color}|${offset.x}|${offset.y}|${e.radius}|${e.spread ?? 0}`;
          const entry = shadows.get(key) ?? {
            type: String(e.type), color, x: offset.x, y: offset.y,
            blur: Number(e.radius ?? 0), spread: Number(e.spread ?? 0), count: 0,
          };
          entry.count++;
          shadows.set(key, entry);
        }
      }
    }
  });

  const byCountDesc = <T extends { count: number }>(a: T, b: T) => b.count - a.count;
  const numericAsc = (a: [number, number], b: [number, number]) => a[0] - b[0];

  return {
    colors: [...colors.values()]
      .sort(byCountDesc)
      .map((c) => ({ hex: c.hex, usageCount: c.count, sampleLayers: [...c.samples] })),
    typography: [...type.values()]
      .sort(byCountDesc)
      .map((t) => ({
        fontFamily: t.family, fontSize: t.size, fontWeight: t.weight,
        lineHeight: t.lineHeight, letterSpacing: t.letterSpacing, usageCount: t.count,
      })),
    spacingScale: [...spacing.entries()].sort(numericAsc).map(([value, count]) => ({ value, usageCount: count })),
    borderRadius: [...radii.entries()].sort(numericAsc).map(([value, count]) => ({ value, usageCount: count })),
    shadows: [...shadows.values()].sort(byCountDesc),
  };
}

/** Turn a frame/screen name into a route-like slug. */
function toRoute(name: string): string {
  const clean = name.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!clean || clean === 'home' || clean === 'landing' || clean === 'index') return '/';
  return `/${clean}`;
}

/**
 * Analyze document structure the way a developer planning the build would:
 * pages, screens, suggested routes, and component usage.
 */
export function analyzeStructure(root: FigmaNode): unknown {
  const pages = (root.children ?? []).map((page) => {
    const frames = (page.children ?? []).filter(
      (c) => c.type === 'FRAME' || c.type === 'COMPONENT' || c.type === 'SECTION',
    );
    return {
      page: page.name,
      screens: frames.map((f) => ({ id: f.id, name: f.name, suggestedRoute: toRoute(f.name) })),
    };
  });

  // Component inventory and instance usage
  const components: Array<{ id: string; name: string; type: string }> = [];
  const instanceUsage = new Map<string, number>();
  walk(root, (n) => {
    if (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') {
      components.push({ id: n.id, name: n.name, type: n.type });
    }
    if (n.type === 'INSTANCE') {
      const key = String((n as { componentId?: string }).componentId ?? n.name);
      instanceUsage.set(key, (instanceUsage.get(key) ?? 0) + 1);
    }
  });

  const suggestedRoutes = [...new Set(pages.flatMap((p) => p.screens.map((s) => s.suggestedRoute)))];

  return {
    pages,
    suggestedRoutes,
    components,
    mostUsedInstances: [...instanceUsage.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([component, count]) => ({ component, count })),
  };
}

/**
 * Describe a component (or component set) and all its variants, reading
 * componentPropertyDefinitions and per-variant property values.
 */
export function describeComponentVariants(node: FigmaNode): unknown {
  const propDefs = (node as { componentPropertyDefinitions?: Record<string, unknown> }).componentPropertyDefinitions ?? {};

  // A COMPONENT_SET holds variant COMPONENT children whose names encode props,
  // e.g. "State=Hover, Size=Large".
  const variants = (node.children ?? [])
    .filter((c) => c.type === 'COMPONENT')
    .map((c) => {
      const props: Record<string, string> = {};
      for (const part of c.name.split(',')) {
        const [k, v] = part.split('=').map((s) => s.trim());
        if (k && v) props[k] = v;
      }
      return { id: c.id, name: c.name, properties: props };
    });

  return {
    id: node.id,
    name: node.name,
    type: node.type,
    propertyDefinitions: propDefs,
    variants,
    variantCount: variants.length,
  };
}
