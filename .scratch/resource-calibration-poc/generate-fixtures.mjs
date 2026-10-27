import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const rn = path.join(here, "fixtures", "react-native", "assets");
const flutter = path.join(here, "fixtures", "flutter", "assets", "images");

function writePng(file, width, height, color = [230, 230, 230, 255]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) png.data.set(color, i * 4);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

const variants = {
  avatar: { logical: [72, 72], scales: [1, 2, 3] },
  hero: { logical: [343, 160], scales: [1, 2, 3] },
  banner: { logical: [343, 120], scales: [1, 2] }
};

for (const [name, spec] of Object.entries(variants)) {
  for (const scale of spec.scales) {
    const [w, h] = spec.logical;
    const suffix = scale === 1 ? "" : `@${scale}x`;
    writePng(path.join(rn, `${name}${suffix}.png`), w * scale, h * scale, [210, 220, 240, 255]);
  }
}

for (const [name, spec] of Object.entries(variants)) {
  for (const scale of spec.scales) {
    const [w, h] = spec.logical;
    const dir = scale === 1 ? flutter : path.join(flutter, `${scale}.0x`);
    writePng(path.join(dir, `${name}.png`), w * scale, h * scale, [220, 230, 210, 255]);
  }
}

console.log("fixture PNGs written");
