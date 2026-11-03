#!/usr/bin/env bash
# Deploy this checkout into the local DSH profile.
#
# Editing ~/src/dsh-claude-compat does NOT change what DSH runs: DSH imports the
# copy under the profile's node_modules, and only at process start. This script
# copies the source over that copy and reminds you to restart.
#
#   bash scripts/deploy-local.sh                 # default profile: desktop
#   bash scripts/deploy-local.sh --profile web
#   bash scripts/deploy-local.sh --no-backup
#   bash scripts/deploy-local.sh --dry-run       # show what would change
#
# Environment: DSH_HOME (default ~/.dsh), DSH_PROFILE (default desktop).
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-desktop}"
BACKUP=1
DRY_RUN=0

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)   PROFILE="${2:?--profile 需要参数}"; shift 2 ;;
    --no-backup) BACKUP=0; shift ;;
    --dry-run)   DRY_RUN=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "未知参数: $1（用 --help 看用法）" >&2; exit 1 ;;
  esac
done

TARGET="$DSH_HOME/profiles/$PROFILE/node_modules/dsh-claude-compat"
if [[ ! -d "$TARGET" ]]; then
  cat >&2 <<EOF
找不到已安装的插件：
  $TARGET

先把它装进 profile：
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \\
    plugin --profile $PROFILE add dsh-claude-compat@latest
EOF
  exit 1
fi

# Everything the package actually ships is mirrored, not just src/: the manager
# commands execute scripts/cc-*.mjs and the bundle is declared by
# cordis.patch.yml, so a src-only sync leaves DSH running a half-updated plugin
# (new source, old scripts, old bundle patch). --delete keeps each mirrored tree
# exact — stale modules would otherwise linger and still get imported.
DEPLOY_FILES=(package.json cordis.patch.yml README.md README.zh-CN.md CHANGELOG.md CHANGELOG.zh-CN.md)

# Dry run first: no backup is created, nothing is written.
if [[ $DRY_RUN -eq 1 ]]; then
  echo "变动预览（不会写入）："
  changed=0
  for pair in "src:src" "scripts:scripts"; do
    s="${pair%%:*}"; d="${pair##*:}"
    [[ -d "$SRC_DIR/$s" ]] || continue
    # -c compares content, so timestamp-only differences stay quiet.
    out="$(rsync -anc --delete --itemize-changes "$SRC_DIR/$s/" "$TARGET/$d/")"
    # Keep only real work: `>` (would transfer) and `*deleting`; a leading `.`
    # means "identical, only the mtime differs" — not worth reporting.
    out="$(printf '%s\n' "$out" | grep -E '^(>|\*deleting)' || true)"
    if [[ -n "$out" ]]; then
      changed=1
      printf '%s\n' "$out" | sed "s|^|  $d/ |"
    fi
  done
  for f in "${DEPLOY_FILES[@]}"; do
    [[ -f "$SRC_DIR/$f" ]] || continue
    if ! cmp -s "$SRC_DIR/$f" "$TARGET/$f"; then changed=1; echo "  $f 有差异"; fi
  done
  [[ $changed -eq 0 ]] && echo "  （无差异，已是最新）"
  exit 0
fi

# A deployed copy older than the checkout is the exact failure this script
# exists to prevent; say what is being overwritten so it is recoverable.
if [[ $BACKUP -eq 1 ]]; then
  BK="$DSH_HOME/backups/dsh-claude-compat-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BK"
  cp -a "$TARGET"/. "$BK"/
  echo "备份 → $BK"
fi


for pair in "src:src" "scripts:scripts"; do
  s="${pair%%:*}"; d="${pair##*:}"
  [[ -d "$SRC_DIR/$s" ]] || continue
  rsync -a --delete "$SRC_DIR/$s/" "$TARGET/$d/"
done
for f in "${DEPLOY_FILES[@]}"; do
  [[ -f "$SRC_DIR/$f" ]] && cp -a "$SRC_DIR/$f" "$TARGET/$f"
done

# Verify the mirror instead of trusting rsync's exit code.
for pair in "src:src" "scripts:scripts"; do
  s="${pair%%:*}"; d="${pair##*:}"
  [[ -d "$SRC_DIR/$s" ]] || continue
  if ! diff -r "$SRC_DIR/$s" "$TARGET/$d" >/dev/null; then
    echo "✗ $d 复制后校验不一致，请检查权限" >&2
    exit 1
  fi
done
for f in "${DEPLOY_FILES[@]}"; do
  if [[ -f "$SRC_DIR/$f" ]] && ! cmp -s "$SRC_DIR/$f" "$TARGET/$f"; then
    echo "✗ $f 复制后校验不一致，请检查权限" >&2
    exit 1
  fi
done

# Syntax-check what the host is about to import: a typo here takes the whole
# plugin down at next start, and the failure surfaces far from this script.
for f in "$TARGET"/src/*.js "$TARGET"/src/*.mjs "$TARGET"/scripts/*.mjs; do
  [[ -f "$f" ]] || continue
  node --check "$f" || { echo "✗ 语法检查失败: $f" >&2; exit 1; }
done

VERSION="$(node -p "require('$TARGET/package.json').version" 2>/dev/null || echo '?')"
echo "✓ 已同步 → $TARGET"
echo "  版本: $VERSION"

# Plugin MCP mounting is decided by the package's own schema default (true since
# 1.0.3), so the old "add enablePluginMcp: true to the profile patch" hint was
# stale and sent people to edit a layer the reinstall wipes. Check the deployed
# copy instead: if the default is off AND the profile does not override it, say so.
PROFILE_PATCH="$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"
DEPLOYED_DEFAULT="$(grep -o "enablePluginMcp: z.boolean().default([a-z]*)" "$TARGET/src/index.js" 2>/dev/null | grep -o "[a-z]*)$" | tr -d ')')"
if [[ "$DEPLOYED_DEFAULT" = "false" ]] && ! grep -q "enablePluginMcp: true" "$PROFILE_PATCH" 2>/dev/null; then
  echo "  提示: 部署副本的 enablePluginMcp 默认是 false 且 profile 未覆盖 —— 插件自带 MCP server 不会挂载。"
fi

echo
echo "⚠ 插件在 DSH 启动时 import，改完必须重启 DSH 进程才生效（不是刷新窗口）。"
echo "  配置项（cordis.patch.yml）同理。"
