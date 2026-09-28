#!/usr/bin/env bash
# Build a portable artemis dependency bundle (uv cache + manifest).
#
#   ./scripts/artemis-deps.sh build [--out DIR] [--repo DIR] [--work DIR] [--zstd] [--skip-sync]
#
# Produces: <out>/artemis-deps-<os>-<arch>.tar.gz (+ .sha256)
#
# The bundle is consumed by the service on first run: it downloads the archive,
# verifies the checksum and runs `uv sync --frozen --no-install-project --offline`
# against the bundled uv cache (see src/artemis/bootstrap.ts).
#
# Bundle is per-platform: build one for each OS/arch you deploy to
# (e.g. darwin-arm64 for Macs, linux-x86_64 inside CI/container).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO="${SERVICE_ROOT}/artemis"
OUT="${SERVICE_ROOT}/dist-deps"
WORK=""
COMPRESS="gz"
SKIP_SYNC=0

while [ $# -gt 0 ]; do
  case "$1" in
    build) ;;
    --out) OUT="$2"; shift ;;
    --repo) REPO="$2"; shift ;;
    --work) WORK="$2"; shift ;;
    --zstd) COMPRESS="zst" ;;
    --skip-sync) SKIP_SYNC=1 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
NAME="artemis-deps-${OS}-${ARCH}"
mkdir -p "${OUT}"
if [ -z "${WORK}" ]; then
  WORK="${OUT}/.work"
fi
CACHE="${WORK}/uv-cache"
mkdir -p "${WORK}"

echo "[1/5] uv sync --frozen --no-install-project（缓存: ${CACHE}）"
if [ "${SKIP_SYNC}" -eq 0 ]; then
  # 用独立构建 venv 强制一次真实安装，确保缓存被完整填充
  # （若直接对已有 .venv 执行，uv 会跳过安装、留下空缓存）。
  rm -rf "${WORK}/venv"
  (cd "${REPO}" && \
    UV_CACHE_DIR="${CACHE}" UV_PROJECT_ENVIRONMENT="${WORK}/venv" \
    uv sync --frozen --no-install-project)
  # 再用（已预热的）缓存补齐仓库自己的 .venv（首次为安装，之后秒级）
  (cd "${REPO}" && UV_CACHE_DIR="${CACHE}" uv sync --frozen --no-install-project)
fi
[ -d "${CACHE}" ] || { echo "缓存目录不存在（先用 --skip-sync 需要已有 ${CACHE}）" >&2; exit 2; }

echo "[2/5] 采集元数据 + 写入版本标记（供服务端过期检测）"
PY_VERSION="$("${REPO}/.venv/bin/python" -V 2>/dev/null | awk '{print $2}')"
UV_VERSION="$(uv --version | awk '{print $2}')"
LOCK_SHA="$(sha256 "${REPO}/uv.lock")"
COMMIT="$(git -C "${REPO}" rev-parse --short HEAD 2>/dev/null || echo unknown)"

if [ -d "${REPO}/.venv" ]; then
  cat > "${REPO}/.venv/.aos-deps.json" <<EOF
{
  "schema": 1,
  "lockSha256": "${LOCK_SHA}",
  "pythonVersion": "${PY_VERSION}",
  "source": { "type": "local-build" },
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
fi

cat > "${WORK}/manifest.json" <<EOF
{
  "schema": 1,
  "platform": { "os": "${OS}", "arch": "${ARCH}" },
  "pythonVersion": "${PY_VERSION}",
  "uv": "${UV_VERSION}",
  "artemisCommit": "${COMMIT}",
  "lockSha256": "${LOCK_SHA}",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo "[3/5] 打包（${COMPRESS}）"
if [ "${COMPRESS}" = "zst" ] && command -v zstd >/dev/null 2>&1; then
  ARCHIVE="${OUT}/${NAME}.tar.zst"
  tar -cf - -C "${WORK}" uv-cache manifest.json | zstd -T0 -q -o "${ARCHIVE}"
else
  ARCHIVE="${OUT}/${NAME}.tar.gz"
  tar -czf "${ARCHIVE}" -C "${WORK}" uv-cache manifest.json
fi

echo "[4/5] 生成校验和"
sha256 "${ARCHIVE}" > "${ARCHIVE}.sha256"

SIZE="$(du -h "${ARCHIVE}" | awk '{print $1}')"
echo "[5/5] 完成: ${ARCHIVE}（${SIZE}）"
echo "sha256: $(cat "${ARCHIVE}.sha256")"
echo ""
echo "缓存工作目录保留在 ${WORK}（复用可加 --skip-sync；不需要时可直接删除）"
echo ""
echo "发布与使用："
echo "  1) 将 ${ARCHIVE} 上传到内部文件服务（或共享盘）；"
echo "  2) 目标项目配置 AOS_ARTEMIS_DEPS_URL=<下载地址>（可选 AOS_ARTEMIS_DEPS_SHA256=<上面的 sha256>）；"
echo "  3) 首次运行（serve/doctor --install-deps）自动下载并离线安装。"
