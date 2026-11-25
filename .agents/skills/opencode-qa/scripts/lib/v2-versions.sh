#!/usr/bin/env bash
# v2-versions.sh - the single place the opencode-qa tooling pins the
# OpenCode 2 host version.
#
# Source it from a sibling script:
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   . "$SCRIPT_DIR/lib/v2-versions.sh"
#
# Do not hardcode the version anywhere else; source this file instead.

OC2_VERSION="2.4.1"
