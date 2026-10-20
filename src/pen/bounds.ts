import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PenTextBound {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PenBoundsOptions {
  penPath?: string;
  timeoutMs?: number;
}

const SCRIPT = `execute({ input: "Get((n,c)=>{if(n.type==='text'){let x=0,y=0,p=c;while(p){x+=p.bounds.x;y+=p.bounds.y;p=p.parentCtx};Print('BOUNDS|'+n.id+'|'+x+'|'+y+'|'+c.bounds.width+'|'+c.bounds.height)}})" })
exit()
`;

/** Ask the pen CLI for resolved text bounds (absolute design px) when the
 * `.pen` uses auto-layout and raw x/y/width/height are absent. This is a
 * best-effort enrichment: callers fall back to raw geometry on failure. */
export function readPenTextBounds(file: string, options: PenBoundsOptions = {}): PenTextBound[] {
  const pen = options.penPath ?? process.env.AOS_PEN_CLI_PATH?.trim() ?? "pen";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-pen-bounds-"));
  const out = path.join(tmpDir, "out.pen");
  try {
    const stdout = execFileSync(pen, ["interactive", "--in", file, "--out", out], {
      input: SCRIPT,
      encoding: "utf-8",
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 16 * 1024 * 1024
    });
    const bounds: PenTextBound[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^BOUNDS\|([^|]+)\|(-?[\d.]+)\|(-?[\d.]+)\|(-?[\d.]+)\|(-?[\d.]+)\s*$/.exec(
        line.trim()
      );
      if (!match) continue;
      const [, id, x, y, width, height] = match;
      bounds.push({
        id: id!,
        x: Number(x),
        y: Number(y),
        width: Number(width),
        height: Number(height)
      });
    }
    return bounds;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
