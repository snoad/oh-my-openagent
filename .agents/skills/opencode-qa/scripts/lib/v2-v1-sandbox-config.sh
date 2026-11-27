#!/usr/bin/env bash
# v2-v1-sandbox-config.sh - the ONE source of truth for the V1 sandbox config.
#
# Both V1 QA scripts must present the SAME config to the plugin or the live
# tool list drifts from the captured baseline purely through config (wave 3
# changed no V1 source file, so config is the only channel that can differ):
#   - v2-v1-baseline.sh    captures the committed fixtures under
#                          packages/omo-opencode/src/opencode-v2/parity/
#                          fixtures/v1-baseline/ with this config
#   - v2-v1-regression.sh  compares against those fixtures under this config
#
# Sourced library (no $1 dispatch guard: a sourced lib sees the CALLER's
# positional parameters, so a bottom flag guard would fire at source time).
#
# Call AFTER oqa_mk_isolated_xdg: the function writes into the sandboxed
# $HOME and $XDG_CONFIG_HOME and creates the parent directories itself.
#
#   oqa_v1_write_sandbox_config <repo_root>

oqa_v1_write_sandbox_config() {
  local repo_root="$1"
  mkdir -p "$HOME/.omo"
  # The omo config the live driver writes: the atlas model override plus the
  # plugin harness keys (hashline edit on, look_at disabled) so the pipeline
  # embeds the same tool list the live host embeds.
  cat > "$HOME/.omo/omo.jsonc" <<'JSON'
{
  "agents": { "atlas": { "model": "anthropic/claude-sonnet-5" } },
  "[opencode]": { "hashline_edit": true, "disabled_tools": ["look_at"] }
}
JSON
  mkdir -p "$XDG_CONFIG_HOME/opencode"
  # The model universe of the live OpenCode 2 parity driver (default model
  # openai/gpt-fake and its provider block); the baseURL is never dialed
  # during the capture (GET /agent + GET /experimental/tool only).
  cat > "$XDG_CONFIG_HOME/opencode/opencode.jsonc" <<JSON
{
  "model": "openai/gpt-fake",
  "plugin": ["file://$repo_root"],
  "provider": {
    "openai": {
      "options": { "apiKey": "fake-key", "baseURL": "http://127.0.0.1:9/v1" },
      "models": {
        "gpt-fake": { "tool_call": true, "limit": { "context": 200000, "output": 8192 } }
      }
    }
  }
}
JSON
}
