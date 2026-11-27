#!/usr/bin/env bash
# v2-versions.sh - the single place the opencode-qa tooling pins the
# OpenCode 2 host version (OC2_VERSION) and the OpenCode 1 host version
# (V1_VERSION; the system opencode the V1 baseline capture and the CI
# baseline recapture run on).
#
# Source it from a sibling script:
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   . "$SCRIPT_DIR/lib/v2-versions.sh"
#
# Do not hardcode the versions anywhere else; source this file instead.

OC2_VERSION="2.4.1"
V1_VERSION="1.19.4"
