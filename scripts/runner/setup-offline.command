#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT"
export AOS_PROJECT_DIR="$ROOT/project"
export PATH="$ROOT/tools/platform-tools:$PATH"
export AOS_PEN_SKIP=1
export AOS_PEN_NO_INSTALL=1
export AOS_LLM_FROM_CENTER=1
export UV_PYTHON=3.12
export UV_SYSTEM_CERTS=1

DEPS="$ROOT/deps/darwin-arm64-site-packages.zip"
if [ ! -f "$DEPS" ]; then
  echo "[offline] 缺少 deps/darwin-arm64-site-packages.zip。"
  exit 2
fi
if ! command -v uv >/dev/null 2>&1; then
  echo "[offline] 未找到 uv；先安装 uv（离线环境可把 uv 放到 PATH）。"
  exit 2
fi

VENV="$ROOT/artemis/.venv"
PY="$VENV/bin/python"
if [ ! -x "$PY" ] || ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) else 1)' >/dev/null 2>&1; then
  echo "[offline] 创建 Python 3.12 venv..."
  rm -rf "$VENV"
  uv venv --python 3.12 "$VENV"
fi
if [ ! -x "$PY" ]; then
  echo "[offline] venv 创建失败；确认 Python 3.12 可用（uv python find 3.12）。"
  exit 2
fi

SITE="$VENV/lib/python3.12/site-packages"
mkdir -p "$SITE"
echo "[offline] 解压 macOS arm64 依赖（解压后约 850MB）..."
unzip -q -o "$DEPS" -d "$SITE"
if [ ! -f "$SITE/pydantic/__init__.py" ]; then
  echo "[offline] 依赖解压失败。"
  exit 2
fi
rm -rf "$SITE/artemis_client"
cp -R "$ROOT/artemis/packages/artemis-client/src/artemis_client" "$SITE/artemis_client"
node -e "const fs=require('fs'),crypto=require('crypto');const h=crypto.createHash('sha256').update(fs.readFileSync('artemis/uv.lock')).digest('hex');fs.writeFileSync('artemis/.venv/.aos-deps.json',JSON.stringify({schema:1,lockSha256:h,pythonVersion:'3.12',source:{type:'bundle',url:'offline:darwin-arm64-site-packages.zip'},installedAt:new Date().toISOString()},null,2)+'\n')"
echo "[offline] 依赖安装完成。"
node dist/cli.js doctor
exit 0
