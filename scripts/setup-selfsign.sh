#!/usr/bin/env bash
# 创建一个固定的自签名「代码签名」证书，用于给 cc-trafficlight.app 签名。
# 目的：让 App 的 designated requirement 恒定不变，这样 macOS 的辅助功能/自动化
# 授权能跨「重新打包」保留 —— 不必每次 build 后重新授权。
# 幂等：证书已存在则跳过。一次性运行即可。
set -euo pipefail
CERT_NAME="cc-trafficlight-selfsign"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-certificate -c "$CERT_NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "证书 '$CERT_NAME' 已存在，跳过。"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/cs.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = cc-trafficlight-selfsign
[v3]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/cs.cnf" 2>/dev/null

# 注意：macOS 的 `security import` 读不了 OpenSSL3 默认的 p12 加密，必须用 -legacy
openssl pkcs12 -export -legacy -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -out "$TMP/id.p12" -passout pass:cctl -name "$CERT_NAME" 2>/dev/null

# -A 允许任意程序使用该私钥（避免 codesign 每次弹钥匙串确认）
security import "$TMP/id.p12" -k "$KEYCHAIN" -P cctl -A -T /usr/bin/codesign

echo "证书 '$CERT_NAME' 已创建并导入登录钥匙串。"
echo "（自签名证书不需要被信任也能用于 codesign 签名。）"
