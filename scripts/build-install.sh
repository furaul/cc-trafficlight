#!/usr/bin/env bash
# 构建 release → 用固定自签名证书签名 → 覆盖安装到 /Applications → 去隔离 → 启动。
# 用固定证书签名后，App 的 designated requirement 不变，已授予的辅助功能/自动化
# 权限会保留，无需每次重装后重新授权。
# 若本机没有该证书（如其他开发者），自动跳过签名，行为同普通 build。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CERT_NAME="cc-trafficlight-selfsign"
APP="$ROOT/app/src-tauri/target/release/bundle/macos/cc-trafficlight.app"
DST="/Applications/cc-trafficlight.app"

echo "==> 构建 release ..."
( cd "$ROOT/app" && npm run tauri build )

if security find-certificate -c "$CERT_NAME" "$HOME/Library/Keychains/login.keychain-db" >/dev/null 2>&1; then
  echo "==> 用 '$CERT_NAME' 签名 ..."
  codesign --force --deep -s "$CERT_NAME" "$APP"
  codesign -dvv "$APP" 2>&1 | grep -i 'Authority=' || true
else
  echo "==> 未找到证书 '$CERT_NAME'，跳过签名（先跑 scripts/setup-selfsign.sh 可启用稳定授权）。"
fi

echo "==> 覆盖安装到 /Applications ..."
pkill -x cc-trafficlight 2>/dev/null || true
sleep 1
rm -rf "$DST"
cp -R "$APP" "$DST"
xattr -dr com.apple.quarantine "$DST" 2>/dev/null || true

echo "==> 启动 ..."
open "$DST"
echo "完成。若首次启用签名，请到「系统设置 → 隐私与安全性 → 辅助功能」授权一次；之后重装无需再授权。"
