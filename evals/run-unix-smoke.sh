#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo 'usage: run-unix-smoke.sh <source-root> [report-path]' >&2
  exit 2
fi

source_root=$(cd "$1" && pwd -P)
report_path=${2:-}
if [[ -n "$report_path" ]]; then
  mkdir -p "$(dirname "$report_path")"
  report_path="$(cd "$(dirname "$report_path")" && pwd -P)/$(basename "$report_path")"
fi

source_revision=${DSH_MEMORY_SOURCE_REVISION:-$(git -C "$source_root" rev-parse HEAD 2>/dev/null || printf 'unknown')}
git_status_args=(status --porcelain --untracked-files=all -- . ':(exclude)evals/reports/**')
if git -C "$source_root" "${git_status_args[@]}" >/dev/null 2>&1; then
  if [[ -n "$(git -C "$source_root" "${git_status_args[@]}")" ]]; then
    source_dirty=true
  else
    source_dirty=false
  fi
else
  source_dirty=true
fi
temporary_root=$(mktemp -d /tmp/dsh-memory-unix-XXXXXX)
trap 'rm -rf -- "$temporary_root"' EXIT

node_version=${DSH_MEMORY_UNIX_NODE_VERSION:-24.20.0}
if [[ ! "$node_version" =~ ^24\.[0-9]+\.[0-9]+$ ]]; then
  echo "unsupported Node 24 version: $node_version" >&2
  exit 2
fi
node_base="https://nodejs.org/dist/v$node_version"
curl -fsSL "$node_base/SHASUMS256.txt" -o "$temporary_root/SHASUMS256.txt"
artifact="node-v${node_version}-linux-x64.tar.xz"
if ! grep -q "  $artifact$" "$temporary_root/SHASUMS256.txt"; then
  echo "unexpected Node artifact: $artifact" >&2
  exit 1
fi
curl -fsSL "$node_base/$artifact" -o "$temporary_root/$artifact"
(
  cd "$temporary_root"
  grep "  $artifact$" SHASUMS256.txt | sha256sum --check --strict
)
tar -C "$temporary_root" -xf "$temporary_root/$artifact"
node_root="$temporary_root/${artifact%.tar.xz}"

export PATH="$node_root/bin:$PATH"
"$node_root/bin/npm" install --global --prefix "$temporary_root/pnpm" \
  --registry=https://registry.npmjs.org pnpm@10.33.0 >/dev/null
export PATH="$temporary_root/pnpm/bin:$PATH"

mkdir "$temporary_root/source"
tar -C "$source_root" \
  --exclude=.git --exclude=node_modules --exclude=lib --exclude=coverage \
  --exclude='evals/.runs' --exclude='evals/reports' \
  -cf - . | tar -C "$temporary_root/source" -xf -

cd "$temporary_root/source"
pnpm install --frozen-lockfile --registry=https://registry.npmjs.org
pnpm run check
pnpm run test:integration
pnpm run eval:keyless

if [[ -n "$report_path" ]]; then
  export DSH_MEMORY_UNIX_REPORT="$report_path"
  export DSH_MEMORY_UNIX_NODE="$(node --version)"
  export DSH_MEMORY_UNIX_ARCH="$(uname -m)"
  export DSH_MEMORY_UNIX_OS="$(. /etc/os-release && printf '%s %s' "$NAME" "$VERSION_ID")"
  export DSH_MEMORY_UNIX_SOURCE_REVISION="$source_revision"
  export DSH_MEMORY_UNIX_SOURCE_DIRTY="$source_dirty"
  node --input-type=module -e '
    import { writeFileSync } from "node:fs";
    const report = {
      format: "dsh-memory-unix-smoke",
      version: 1,
      status: "PASS",
      pass: true,
      finishedAt: new Date().toISOString(),
      os: process.env.DSH_MEMORY_UNIX_OS,
      arch: process.env.DSH_MEMORY_UNIX_ARCH,
      node: process.env.DSH_MEMORY_UNIX_NODE,
      sourceRevision: process.env.DSH_MEMORY_UNIX_SOURCE_REVISION,
      sourceDirty: process.env.DSH_MEMORY_UNIX_SOURCE_DIRTY === "true",
      packageManager: "pnpm@10.33.0",
      checks: {
        frozenInstall: true,
        packageCheck: true,
        loaderIntegration: true,
        keylessEvaluation: true,
      },
    };
    writeFileSync(process.env.DSH_MEMORY_UNIX_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  '
fi
