#!/usr/bin/env bash
# v2-bootstrap.sh - install an ISOLATED OpenCode 2 host binary for QA.
#
# Installs @opencode/cli@$OC2_VERSION into $OC2_HOME (never globally) and
# verifies it. The npm package exposes two bin names, `opencode` and
# `opencode2`; the QA tooling uses `opencode2` so the system opencode
# (e.g. /usr/sbin/opencode, V1) stays untouched and stays first on PATH.
#
# Usage:
#   v2-bootstrap.sh            bootstrap (idempotent); last line is "<OC2> <version>"
#   v2-bootstrap.sh --self-test
#   v2-bootstrap.sh -h|--help
#
# Environment:
#   OMO_QA_OC2_HOME  override the install home
#                    (default: $HOME/.cache/omo-qa/opencode-v2/$OC2_VERSION)
#
# Safety: no `npm i -g`, no PATH mutation, no writes outside $OC2_HOME.
# The version pin lives in lib/v2-versions.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/common.sh"
. "$SCRIPT_DIR/lib/v2-versions.sh"

OC2_HOME="${OMO_QA_OC2_HOME:-$HOME/.cache/omo-qa/opencode-v2/$OC2_VERSION}"
OC2="$OC2_HOME/node_modules/.bin/opencode2"
# Touched only by a successful install; the self-test uses its unchanged
# mtime as the deterministic proof that a second run performs no install.
OC2_INSTALL_MARKER="$OC2_HOME/.omo-qa-install-marker"

# Refuse an OC2_HOME the user cannot write to, naming the path. The check
# probes the owner write MODE BIT because access(2)-based -w is always true
# for root, and the QA failure path deliberately locks the home with
# chmod 555 (mktemp -d makes the QA user the owner).
oqa_v2_ensure_home() {
  local home="$1" perms
  if ! mkdir -p "$home" 2>/dev/null; then
    oqa_log "FAIL: cannot create OC2_HOME (unwritable parent): $home"
    return 1
  fi
  perms="$(stat -c '%a' "$home" 2>/dev/null)" || perms=""
  perms="${perms: -3}"
  case "${perms:0:1}" in
    0|1|4|5)
      oqa_log "FAIL: OC2_HOME is not writable (mode $perms): $home"
      return 1 ;;
  esac
  return 0
}

# Normalized --version of a launcher: the last token with an optional leading
# "v" stripped. V1 prints "1.19.4", V2 prints "opencode v2.4.1"; both must
# compare equal to $OC2_VERSION. Always exits 0 (empty on failure).
oqa_v2_bin_version() {
  "$1" --version 2>/dev/null | tail -1 | awk '{v=$NF; sub(/^v/,"",v); print v}' || true
}

# npm >= 12 refuses to run install scripts unless allowlisted, and
# @opencode/cli REQUIRES its postinstall (it copies the platform binary into
# bin/). npm's own warning says to run the package postinstall; do exactly
# that, writing inside OC2_HOME only. No-op when the launcher already works.
oqa_v2_repair_postinstall() {
  if [ "$(oqa_v2_bin_version "$OC2")" = "$OC2_VERSION" ]; then
    return 0
  fi
  local pkg_dir="$OC2_HOME/node_modules/@opencode/cli"
  if [ ! -f "$pkg_dir/postinstall.mjs" ]; then
    oqa_log "FAIL: $OC2 broken and no postinstall.mjs found under $pkg_dir"
    return 1
  fi
  oqa_log "npm blocked install scripts; running @opencode/cli postinstall directly"
  (cd "$pkg_dir" && node ./postinstall.mjs)
}

oqa_v2_bootstrap() {
  oqa_require npm node || exit 1
  oqa_v2_ensure_home "$OC2_HOME" || exit 1

  local cur=""
  if [ -x "$OC2" ]; then
    cur="$(oqa_v2_bin_version "$OC2")"
  fi
  if [ "$cur" = "$OC2_VERSION" ]; then
    oqa_log "install skipped (already at $OC2_VERSION)"
    # ensure the marker exists without bumping an existing mtime
    [ -e "$OC2_INSTALL_MARKER" ] || : > "$OC2_INSTALL_MARKER"
  else
    if [ -x "$OC2" ]; then
      # launcher present but failing: repair in place before reinstalling
      oqa_v2_repair_postinstall || true
      cur="$(oqa_v2_bin_version "$OC2")"
    fi
    if [ "$cur" = "$OC2_VERSION" ]; then
      oqa_log "install skipped after postinstall repair (already at $OC2_VERSION)"
      [ -e "$OC2_INSTALL_MARKER" ] || : > "$OC2_INSTALL_MARKER"
    else
      oqa_log "installing @opencode/cli@$OC2_VERSION into $OC2_HOME"
      npm install --prefix "$OC2_HOME" --no-audit --no-fund --no-save "@opencode/cli@$OC2_VERSION"
      oqa_v2_repair_postinstall
      : > "$OC2_INSTALL_MARKER"
      oqa_log "install complete"
    fi
  fi

  if [ ! -x "$OC2" ]; then
    oqa_log "FAIL: $OC2 is not executable after bootstrap"
    exit 1
  fi
  local ver
  ver="$(oqa_v2_bin_version "$OC2")"
  if [ "$ver" != "$OC2_VERSION" ]; then
    oqa_log "FAIL: $OC2 --version printed '$ver', expected '$OC2_VERSION'"
    exit 1
  fi
  # LAST line: the resolved OC2 path and its version
  printf '%s %s\n' "$OC2" "$ver"
}

oqa_self_test() {
  oqa_require opencode npm node || return 1
  local fails=0

  local sys_cmd_before sys_ver_before sys_cmd_after sys_ver_after
  sys_cmd_before="$(command -v opencode)"
  sys_ver_before="$(opencode --version 2>/dev/null | tail -1)"
  oqa_log "system opencode before: $sys_cmd_before ($sys_ver_before)"

  # run 1: bootstrap (installs on first use, skips afterwards)
  local rc1=0 out1
  out1="$(bash "${BASH_SOURCE[0]}" 2>&1)" || rc1=$?
  printf '%s\n' "$out1" | sed 's/^/  run1| /' >&2
  if [ "$rc1" -eq 0 ]; then
    oqa_pass "bootstrap run 1 exited 0"
  else
    oqa_log "FAIL: bootstrap run 1 exited $rc1"; fails=$((fails+1))
  fi

  # OC2 executable and printing the pinned version
  local oc2_ver=""
  if [ -x "$OC2" ]; then
    oqa_pass "$OC2 is executable"
    oc2_ver="$(oqa_v2_bin_version "$OC2")"
    if [ "$oc2_ver" = "$OC2_VERSION" ]; then
      oqa_pass "$OC2 --version prints $OC2_VERSION"
    else
      oqa_log "FAIL: $OC2 --version printed '$oc2_ver', expected '$OC2_VERSION'"; fails=$((fails+1))
    fi
  else
    oqa_log "FAIL: $OC2 is not executable"; fails=$((fails+1))
  fi

  # run 2: must perform NO install. Proof used: the install marker
  # ($OC2_INSTALL_MARKER, touched ONLY by a successful install) keeps its
  # mtime, plus the bootstrap itself reports "install skipped". Elapsed time
  # is printed as supporting context, not asserted.
  local m_before m_after t0 t1 rc2=0 out2 elapsed_ms
  m_before="$(stat -c '%Y' "$OC2_INSTALL_MARKER" 2>/dev/null || printf na)"
  t0="$(date +%s%N)"
  out2="$(bash "${BASH_SOURCE[0]}" 2>&1)" || rc2=$?
  t1="$(date +%s%N)"
  elapsed_ms=$(( (t1 - t0) / 1000000 ))
  printf '%s\n' "$out2" | sed 's/^/  run2| /' >&2
  m_after="$(stat -c '%Y' "$OC2_INSTALL_MARKER" 2>/dev/null || printf na)"
  if [ "$rc2" -eq 0 ] && [ -n "$m_before" ] && [ "$m_before" != "na" ] \
     && [ "$m_before" = "$m_after" ] \
     && printf '%s' "$out2" | grep -q "install skipped"; then
    oqa_pass "second run performed no install (proof: install marker mtime unchanged + bootstrap reported 'install skipped'; elapsed ${elapsed_ms}ms)"
  else
    oqa_log "FAIL: second run not proven install-free (rc2=$rc2, marker $m_before -> $m_after)"; fails=$((fails+1))
  fi

  # system opencode untouched: same resolved path and same version
  sys_cmd_after="$(command -v opencode)"
  sys_ver_after="$(opencode --version 2>/dev/null | tail -1)"
  if [ "$sys_cmd_before" = "$sys_cmd_after" ]; then
    oqa_pass "command -v opencode unchanged ($sys_cmd_after)"
  else
    oqa_log "FAIL: command -v opencode changed: '$sys_cmd_before' -> '$sys_cmd_after'"; fails=$((fails+1))
  fi
  if [ "$sys_ver_before" = "$sys_ver_after" ]; then
    oqa_pass "system opencode --version unchanged ($sys_ver_after)"
  else
    oqa_log "FAIL: system opencode --version changed: '$sys_ver_before' -> '$sys_ver_after'"; fails=$((fails+1))
  fi

  # OC2_HOME must never be put on PATH
  case ":$PATH:" in
    *":$OC2_HOME:"*)
      oqa_log "FAIL: OC2_HOME is on PATH: $OC2_HOME"; fails=$((fails+1)) ;;
    *)
      oqa_pass "OC2_HOME not on PATH" ;;
  esac

  if [ "$fails" -eq 0 ]; then
    oqa_pass "v2-bootstrap self-test"
    # LAST line: exactly the pinned version
    printf '%s\n' "$OC2_VERSION"
    return 0
  fi
  oqa_log "v2-bootstrap self-test had $fails failure(s)"
  return 1
}

case "${1:-}" in
  --self-test) oqa_self_test; exit $? ;;
  -h|--help)
    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0 ;;
  "") oqa_v2_bootstrap ;;
  *) oqa_log "unknown argument: $1 (try --help)"; exit 2 ;;
esac
