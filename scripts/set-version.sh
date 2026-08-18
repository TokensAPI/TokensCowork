#!/usr/bin/env bash
# VERSION is the only editable product-version source. This script synchronizes
# the product manifests that must repeat it and verifies release tags.

set -euo pipefail
cd "$(dirname "$0")/.."

normalize_version() {
  local value="${1#v}"
  value="${value//$'\r'/}"
  value="${value//$'\n'/}"
  printf '%s' "$value"
}

read_version() {
  if [[ ! -f VERSION ]]; then
    echo "missing canonical VERSION file" >&2
    exit 1
  fi
  normalize_version "$(<VERSION)"
}

validate_version() {
  if [[ ! "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
    echo "invalid product version: $1" >&2
    exit 1
  fi
}

sync_metadata() {
  VERSION_VALUE="$1" node <<'NODE'
const fs = require('fs')
const version = process.env.VERSION_VALUE

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))
packageJson.version = version
fs.writeFileSync('package.json', `${JSON.stringify(packageJson, null, 2)}\n`)

const product = JSON.parse(fs.readFileSync('product.json', 'utf8'))
product.product.version = version
fs.writeFileSync('product.json', `${JSON.stringify(product, null, 2)}\n`)
NODE
}

check_metadata() {
  VERSION_VALUE="$1" node <<'NODE'
const fs = require('fs')
const expected = process.env.VERSION_VALUE
const packageVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
const productVersion = JSON.parse(fs.readFileSync('product.json', 'utf8')).product?.version
if (packageVersion !== expected || productVersion !== expected) {
  console.error(`version metadata mismatch: VERSION=${expected}, package=${packageVersion}, product=${productVersion}`)
  process.exit(1)
}
NODE
}

mode="${1:-sync}"
requested="$(normalize_version "${VERSION:-}")"
current="$(read_version)"

case "$mode" in
  --print)
    value="${requested:-$current}"
    validate_version "$value"
    printf '%s\n' "$value"
    ;;
  --check)
    validate_version "$current"
    expected="$(normalize_version "${2:-}")"
    if [[ -n "$expected" && "$expected" != "$current" ]]; then
      echo "release tag/version mismatch: tag=$expected VERSION=$current" >&2
      exit 1
    fi
    check_metadata "$current"
    printf 'Version metadata is synchronized: %s\n' "$current"
    ;;
  sync)
    value="${requested:-$current}"
    validate_version "$value"
    printf '%s\n' "$value" > VERSION
    sync_metadata "$value"
    printf 'Version synchronized from VERSION: %s\n' "$value"
    ;;
  *)
    echo "unknown mode: $mode" >&2
    exit 1
    ;;
esac
