#!/usr/bin/env bash
set -euo pipefail

command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash
sudo ln -sf "${HOME}/.bun/bin/bun" /usr/local/bin/bun
sudo ln -sf "${HOME}/.bun/bin/bunx" /usr/local/bin/bunx
bun install --frozen-lockfile
