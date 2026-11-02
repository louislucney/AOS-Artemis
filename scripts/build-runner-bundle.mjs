#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const outDir = path.join(root, "dist-runner");
const targets = [
  { platform: "win32", arch: "x64", archive: "zip" },
  { platform: "darwin", arch: "arm64", archive: "tar.gz" },
  { platform: "linux", arch: "x64", archive: "tar.gz" }
];

if (!fs.existsSync(path.join(root, "dist", "cli.js"))) {
  console.error("缺少 dist/cli.js，请先 npm run build");
  process.exit(2);
}
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const copy = (from, to, filter) => fs.cpSync(from, to, { recursive: true, dereference: true, filter });
const hashFile = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const manifest = [];

for (const target of targets) {
  const stem = `mobile-testing-runner-${pkg.version}-${target.platform}-${target.arch}`;
  const staging = path.join(outDir, stem);
  fs.mkdirSync(staging, { recursive: true });
  copy(path.join(root, "dist"), path.join(staging, "dist"));
  for (const file of ["package.json", "package-lock.json", "README.md", "LICENSE"]) {
    if (fs.existsSync(path.join(root, file))) {
      copy(path.join(root, file), path.join(staging, file));
    }
  }
  copy(path.join(root, "node_modules"), path.join(staging, "node_modules"), (src) => {
    if (target.platform === "darwin") return true;
    return !src.split(path.sep).includes("fsevents");
  });

  fs.writeFileSync(
    path.join(staging, "runner.cmd"),
    '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\nnode dist\\cli.js web-runner %*\r\n',
    "utf8"
  );
  fs.writeFileSync(
    path.join(staging, "runner.sh"),
    '#!/usr/bin/env sh\nset -eu\ncd "$(dirname "$0")"\nexec node dist/cli.js web-runner "$@"\n',
    { encoding: "utf8", mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(staging, "RUNNER.md"),
    `# mobile-testing web-runner bundle (${target.platform}-${target.arch})

## Windows

Requires Node.js >= 20, adb and Maestro on PATH.

\`\`\`powershell
$env:AOS_HOST_ID="win-mini-01"
$env:AOS_RUNNER_CONTROL_URL="http://<center>:8765"
$env:MOBILE_TESTING_RUNNER_JOB_TOKEN="<runner-token>"
.\\runner.cmd --name win-mini-01
\`\`\`

## macOS / Linux

\`\`\`bash
export AOS_HOST_ID=mac-mini-01
export AOS_RUNNER_CONTROL_URL=http://<center>:8765
export MOBILE_TESTING_RUNNER_JOB_TOKEN=<runner-token>
./runner.sh --name mac-mini-01
\`\`\`

The bundle contains dist and node_modules. It does not include Node.js, adb or Maestro.
`,
    "utf8"
  );

  const filename = `${stem}.${target.archive}`;
  const archive = path.join(outDir, filename);
  if (target.archive === "zip") {
    execFileSync("zip", ["-qr", archive, stem], { cwd: outDir, stdio: "inherit" });
  } else {
    execFileSync("tar", ["-czf", archive, "-C", outDir, stem], { stdio: "inherit" });
  }
  fs.rmSync(staging, { recursive: true, force: true });
  const sha256 = hashFile(archive);
  fs.writeFileSync(`${archive}.sha256`, `${sha256}  ${filename}\n`, "utf8");
  manifest.push({
    platform: target.platform,
    arch: target.arch,
    filename,
    size: fs.statSync(archive).size,
    sha256,
    url: `/panel/runner-bundle?platform=${target.platform}&arch=${target.arch}`
  });
  console.log(`${filename}  ${sha256}`);
}

fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`manifest: ${path.join(outDir, "manifest.json")}`);
