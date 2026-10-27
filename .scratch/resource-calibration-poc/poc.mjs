import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectProjectStacksDetailed } from "../../dist/projects/stack.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const designFile = path.join(here, "design", "contract.json");
const fixtures = {
  "react-native": path.join(here, "fixtures", "react-native"),
  flutter: path.join(here, "fixtures", "flutter")
};

function readText(file) {
  return fs.readFileSync(file, "utf-8");
}

function readJson(file) {
  return JSON.parse(readText(file));
}

function relative(file) {
  return path.relative(here, file);
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function numberAfter(source, key) {
  const match = new RegExp(`${key}\\s*:\\s*["']?(-?\\d+(?:\\.\\d+)?)`).exec(source);
  return match === null ? null : Number(match[1]);
}

function stringAfter(source, key) {
  const match = new RegExp(`${key}\\s*:\\s*["']([^"']+)["']`).exec(source);
  return match === null ? null : match[1];
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function sameNumber(left, right, tolerance = 0.01) {
  return left !== null && right !== null && Math.abs(left - right) <= tolerance;
}

function pngSize(file) {
  if (!fs.existsSync(file)) return null;
  const header = fs.readFileSync(file);
  if (header.length < 24 || header.toString("ascii", 1, 4) !== "PNG") return null;
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

function parseRnTypography(projectDir) {
  const file = path.join(projectDir, "src", "theme", "tokens.ts");
  const source = readText(file);
  const typographyStart = source.indexOf("typography");
  const bodyStart = source.indexOf("{", typographyStart);
  const styles = new Map();
  const re = /(\w+)\s*:\s*\{([^{}]*)\}/g;
  re.lastIndex = bodyStart + 1;
  let match;
  while ((match = re.exec(source)) !== null) {
    const body = match[2];
    const fontSize = numberAfter(body, "fontSize");
    if (fontSize === null) continue;
    styles.set(match[1], {
      fontFamily: stringAfter(body, "fontFamily"),
      fontSize,
      lineHeight: numberAfter(body, "lineHeight"),
      letterSpacing: numberAfter(body, "letterSpacing"),
      fontWeight: numberAfter(body, "fontWeight"),
      file: relative(file),
      line: lineOf(source, match.index)
    });
  }
  return styles;
}

function parseRnProject(projectDir) {
  const screenFile = path.join(projectDir, "src", "screens", "Home.tsx");
  const source = readText(screenFile);
  const stylesStart = source.indexOf("const styles");
  const styles = new Map();
  const styleRe = /(\w+)\s*:\s*\{\s*width:\s*(\d+(?:\.\d+)?)\s*,\s*height:\s*(\d+(?:\.\d+)?)\s*\}/g;
  styleRe.lastIndex = stylesStart;
  let styleMatch;
  while ((styleMatch = styleRe.exec(source)) !== null) {
    styles.set(styleMatch[1], {
      width: Number(styleMatch[2]),
      height: Number(styleMatch[3]),
      line: lineOf(source, styleMatch.index)
    });
  }

  const images = [];
  const texts = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const requireMatch = /require\(\s*["']([^"']+)["']\s*\)/.exec(line);
    if (requireMatch !== null) {
      const styleMatch2 = /style=\{styles\.(\w+)\}/.exec(line);
      const resizeMatch = /resizeMode=["'](\w+)["']/.exec(line);
      const style = styleMatch2 === null ? null : styles.get(styleMatch2[1]);
      if (style !== undefined && style !== null) {
        images.push({
          assetPath: path.resolve(path.dirname(screenFile), requireMatch[1]),
          key: path.basename(requireMatch[1], path.extname(requireMatch[1])),
          width: style.width,
          height: style.height,
          fit: resizeMatch?.[1] ?? "cover",
          file: relative(screenFile),
          line: index + 1
        });
      }
    }
    const textMatch =
      /<Text[^>]*style=\{[^}]*typography\.(\w+)[^}]*\}[^>]*numberOfLines=\{(\d+)\}[^>]*>([^<]+)<\/Text>/.exec(
        line
      );
    if (textMatch !== null) {
      texts.push({
        styleKey: textMatch[1],
        content: textMatch[3].trim(),
        maxLines: Number(textMatch[2]),
        file: relative(screenFile),
        line: index + 1
      });
    }
  }

  return {
    stack: "react-native",
    projectDir,
    typography: parseRnTypography(projectDir),
    images,
    texts,
    device: readJson(path.join(projectDir, "device.json"))
  };
}

function parseFlutterTypography(projectDir) {
  const file = path.join(projectDir, "lib", "theme", "tokens.dart");
  const source = readText(file);
  const styles = new Map();
  const re = /static const (\w+)\s*=\s*TextStyle\(([\s\S]*?)\);/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const body = match[2];
    const heightRaw = /height\s*:\s*([^,\n]+)/.exec(body)?.[1]?.trim() ?? null;
    let height = null;
    if (heightRaw !== null) {
      const ratio = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(heightRaw);
      height = ratio === null ? Number(heightRaw) : Number(ratio[1]) / Number(ratio[2]);
      if (Number.isNaN(height)) height = null;
    }
    styles.set(match[1], {
      fontFamily: stringAfter(body, "fontFamily"),
      fontSize: numberAfter(body, "fontSize"),
      height,
      lineHeight: null,
      letterSpacing: numberAfter(body, "letterSpacing"),
      fontWeight: (() => {
        const weight = /FontWeight\.w(\d+)/.exec(body);
        return weight === null ? null : Number(weight[1]);
      })(),
      file: relative(file),
      line: lineOf(source, match.index)
    });
  }
  return styles;
}

function parseFlutterFonts(projectDir) {
  const file = path.join(projectDir, "pubspec.yaml");
  const lines = readText(file).split("\n");
  const families = new Map();
  const assets = [];
  let family = null;
  for (const line of lines) {
    const familyMatch = /^\s*-\s*family:\s*(.+)$/.exec(line);
    if (familyMatch !== null) {
      family = familyMatch[1].trim();
      if (!families.has(family)) families.set(family, new Set());
      continue;
    }
    if (family !== null) {
      const weightMatch = /^\s*weight:\s*(\d+)/.exec(line);
      if (weightMatch !== null) families.get(family).add(Number(weightMatch[1]));
      const assetMatch = /^\s*-\s*asset:\s*(.+)$/.exec(line);
      if (assetMatch !== null && assetMatch[1].startsWith("assets/fonts/")) {
        assets.push(assetMatch[1].trim());
      }
    }
  }
  return { families, assets, file: relative(file) };
}

function parseFlutterProject(projectDir) {
  const screenFile = path.join(projectDir, "lib", "screens", "home.dart");
  const source = readText(screenFile);
  const images = [];
  const texts = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const imageMatch =
      /Image\.asset\(\s*['"]([^'"]+)['"]\s*,\s*width:\s*(\d+(?:\.\d+)?)\s*,\s*height:\s*(\d+(?:\.\d+)?)\s*,\s*fit:\s*BoxFit\.(\w+)\s*\)/.exec(
        line
      );
    if (imageMatch !== null) {
      images.push({
        assetPath: path.resolve(projectDir, imageMatch[1]),
        key: path.basename(imageMatch[1], path.extname(imageMatch[1])),
        width: Number(imageMatch[2]),
        height: Number(imageMatch[3]),
        fit: imageMatch[4],
        file: relative(screenFile),
        line: index + 1
      });
    }
    const textMatch =
      /Text\(\s*['"]([^'"]+)['"]\s*,\s*style:\s*AosTypography\.(\w+)\s*,\s*maxLines:\s*(\d+)\s*\)/.exec(
        line
      );
    if (textMatch !== null) {
      texts.push({
        styleKey: textMatch[2],
        content: textMatch[1],
        maxLines: Number(textMatch[3]),
        file: relative(screenFile),
        line: index + 1
      });
    }
  }

  return {
    stack: "flutter",
    projectDir,
    typography: parseFlutterTypography(projectDir),
    fonts: parseFlutterFonts(projectDir),
    images,
    texts,
    device: readJson(path.join(projectDir, "device.json"))
  };
}

function fitNormalize(stack, fit) {
  if (stack === "react-native") {
    if (fit === "stretch") return "fill";
    return fit;
  }
  if (fit === "fill") return "fill";
  return fit;
}

function imageVariants(code, stack) {
  const base = code.assetPath;
  const dir = path.dirname(base);
  const ext = path.extname(base);
  const name = path.basename(base, ext);
  if (stack === "react-native") {
    return [
      { scale: 1, file: base },
      { scale: 2, file: path.join(dir, `${name}@2x${ext}`) },
      { scale: 3, file: path.join(dir, `${name}@3x${ext}`) }
    ];
  }
  return [
    { scale: 1, file: base },
    { scale: 2, file: path.join(dir, "2.0x", `${name}${ext}`) },
    { scale: 3, file: path.join(dir, "3.0x", `${name}${ext}`) }
  ];
}

function calibrateImage(design, code, project) {
  if (code === undefined) {
    return { kind: "image", id: design.id, status: "unmapped", issues: ["code asset not found"], notes: [] };
  }
  const issues = [];
  if (!sameNumber(code.width, design.logical.width, 0.1)) {
    issues.push(`width ${code.width} != ${design.logical.width}`);
  }
  if (!sameNumber(code.height, design.logical.height, 0.1)) {
    issues.push(`height ${code.height} != ${design.logical.height}`);
  }
  const codeFit = fitNormalize(project.stack, code.fit);
  if (codeFit !== design.fit) {
    issues.push(`fit ${code.fit} != ${design.fit}`);
  }

  if (!fs.existsSync(code.assetPath)) {
    return { kind: "image", id: design.id, status: "unmapped", issues: ["asset file missing"], notes: [] };
  }
  const variants = imageVariants(code, project.stack);
  const available = variants.filter((variant) => fs.existsSync(variant.file)).map((variant) => variant.scale);
  for (const variant of variants) {
    if (!fs.existsSync(variant.file)) continue;
    const dims = pngSize(variant.file);
    if (dims === null) {
      issues.push(`${variant.scale}x unreadable`);
      continue;
    }
    if (
      !sameNumber(dims.width, design.logical.width * variant.scale, 1) ||
      !sameNumber(dims.height, design.logical.height * variant.scale, 1)
    ) {
      issues.push(
        `${variant.scale}x ${dims.width}x${dims.height} != ${design.logical.width * variant.scale}x${design.logical.height * variant.scale}`
      );
    }
  }

  const maxScale = available.length === 0 ? 0 : Math.max(...available);
  const deviceScale = project.device.pixelRatio;
  const upscale = maxScale < deviceScale;
  if (issues.length > 0) {
    return { kind: "image", id: design.id, status: "mismatch", issues, notes: [`variants ${available.join("/")}`] };
  }
  if (upscale) {
    return {
      kind: "image",
      id: design.id,
      status: "upscale",
      issues: [],
      notes: [`variants ${available.join("/")}; device @${deviceScale}x`]
    };
  }
  return { kind: "image", id: design.id, status: "match", issues: [], notes: [`variants ${available.join("/")}`] };
}

function calibrateText(design, code, project) {
  if (code === undefined) {
    return { kind: "text", id: design.id, status: "unmapped", issues: ["code text not found"], notes: [] };
  }
  const style = project.typography.get(code.styleKey);
  if (style === undefined) {
    return { kind: "text", id: design.id, status: "unmapped", issues: [`style ${code.styleKey} not found`], notes: [] };
  }
  const issues = [];
  if (code.content !== design.content) issues.push(`content "${code.content}" != "${design.content}"`);
  if (style.fontFamily !== design.fontFamily) issues.push(`font-family ${style.fontFamily ?? "?"} != ${design.fontFamily}`);
  if (!sameNumber(style.fontSize, design.fontSize, 0.01)) issues.push(`font-size ${style.fontSize} != ${design.fontSize}`);

  const codeLineHeight =
    project.stack === "flutter"
      ? style.height === null || style.fontSize === null
        ? null
        : style.height * style.fontSize
      : style.lineHeight;
  if (codeLineHeight === null) {
    issues.push("line-height unverified");
  } else if (!sameNumber(codeLineHeight, design.lineHeight, 0.1)) {
    issues.push(`line-height ${round(codeLineHeight)} != ${design.lineHeight}`);
  }

  if (!sameNumber(style.letterSpacing, design.letterSpacing, 0.01)) {
    issues.push(`letter-spacing ${style.letterSpacing} != ${design.letterSpacing}`);
  }
  if (!sameNumber(style.fontWeight, design.fontWeight, 0.01)) {
    issues.push(`font-weight ${style.fontWeight} != ${design.fontWeight}`);
  }
  if (code.maxLines !== design.maxLines) issues.push(`max-lines ${code.maxLines} != ${design.maxLines}`);

  let fontWeightStatus = null;
  if (project.stack === "flutter") {
    const weights = project.fonts.families.get(design.fontFamily);
    if (weights === undefined) {
      fontWeightStatus = "font-unbundled";
    } else if (!weights.has(design.fontWeight)) {
      fontWeightStatus = "font-weight-substituted";
    }
  } else {
    fontWeightStatus = "font-weight-unverified";
  }

  const hardIssues = issues.filter((issue) => issue !== "line-height unverified");
  const status =
    hardIssues.length > 0
      ? "mismatch"
      : issues.includes("line-height unverified")
        ? "unverifiable"
        : fontWeightStatus === "font-weight-substituted" || fontWeightStatus === "font-unbundled"
          ? fontWeightStatus
          : "match";
  const notes = [];
  if (fontWeightStatus === "font-weight-unverified") notes.push("RN font file not declared in fixture");
  if (fontWeightStatus === "font-weight-substituted") notes.push(`${design.fontFamily} has no ${design.fontWeight}`);
  if (project.device.fontScale !== 1) notes.push(`device fontScale ${project.device.fontScale}`);
  return { kind: "text", id: design.id, status, issues, notes };
}

function statusCell(row) {
  return row.status;
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function main() {
  const design = readJson(designFile);
  const projects = Object.fromEntries(
    Object.entries(fixtures).map(([name, dir]) => [
      name,
      name === "react-native" ? parseRnProject(dir) : parseFlutterProject(dir)
    ])
  );

  for (const [name, dir] of Object.entries(fixtures)) {
    const report = detectProjectStacksDetailed(dir);
    console.log(`${pad(name, 14)} detection=${report.stacks.map((stack) => stack.id).join(",")} source=${report.source}`);
    for (const stack of report.stacks) {
      for (const evidence of stack.evidence) {
        console.log(`  ${evidence.kind.padEnd(11)} ${evidence.path}${evidence.detail ? ` (${evidence.detail})` : ""}`);
      }
    }
    if (report.warnings.length > 0) console.log(`  warnings: ${report.warnings.join(" | ")}`);
  }

  console.log("");
  console.log(
    `${pad("KIND", 7)}${pad("RESOURCE", 24)}${pad("DESIGN", 24)}${pad("CODE", 42)}${pad("STATUS", 30)}DEVICE`
  );
  console.log("-".repeat(130));

  const rows = [];
  for (const [name, project] of Object.entries(projects)) {
    const label = name === "react-native" ? "RN" : "Flutter";
    for (const designImage of design.images) {
      const code = project.images.find((image) => image.key === designImage.assetKey);
      const row = calibrateImage(designImage, code, project);
      rows.push(row);
      const designText = `${designImage.logical.width}x${designImage.logical.height} ${designImage.fit}`;
      const codeText =
        code === undefined
          ? "not found"
          : `${label} ${code.width}x${code.height} ${code.fit} (${path.basename(code.file)}:${code.line})`;
      const deviceText = `${project.device.nativeUnit} @${project.device.pixelRatio}x`;
      console.log(
        `${pad("image", 7)}${pad(`${name}/${designImage.id}`, 24)}${pad(designText, 24)}${pad(codeText, 42)}${pad(statusCell(row), 30)}${deviceText}`
      );
      if (row.issues.length > 0) console.log(`  issues: ${row.issues.join(" | ")}`);
      if (row.notes.length > 0) console.log(`  notes: ${row.notes.join(" | ")}`);
    }
    for (const designText of design.texts) {
      const code = project.texts.find((text) => text.styleKey === designText.id);
      const row = calibrateText(designText, code, project);
      rows.push(row);
      const designCell = `${designText.fontSize}/${designText.lineHeight} w${designText.fontWeight}`;
      const codeStyle = code === undefined ? null : project.typography.get(code.styleKey);
      const codeCell =
        codeStyle === undefined || codeStyle === null
          ? "not found"
          : (() => {
              const lineHeight =
                codeStyle.lineHeight ??
                (codeStyle.height === null || codeStyle.fontSize === null
                  ? "?"
                  : `${round(codeStyle.height * codeStyle.fontSize)} (height ${round(codeStyle.height)})`);
              return `${label} ${codeStyle.fontSize}/${lineHeight} w${codeStyle.fontWeight}`;
            })();
      const deviceCell =
        project.device.fontScale === 1
          ? "normal"
          : `text-scale ${project.device.fontScale} (${round(designText.fontSize * project.device.fontScale)}pt)`;
      console.log(
        `${pad("text", 7)}${pad(`${name}/${designText.id}`, 24)}${pad(designCell, 24)}${pad(codeCell, 42)}${pad(statusCell(row), 30)}${deviceCell}`
      );
      if (row.issues.length > 0) console.log(`  issues: ${row.issues.join(" | ")}`);
      if (row.notes.length > 0) console.log(`  notes: ${row.notes.join(" | ")}`);
    }
  }

  const counts = {};
  for (const row of rows) counts[`${row.kind}:${row.status}`] = (counts[`${row.kind}:${row.status}`] ?? 0) + 1;
  console.log("");
  console.log("SUMMARY");
  console.log(JSON.stringify(counts, null, 2));
}

main();
