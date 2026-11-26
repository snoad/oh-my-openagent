export const OPENCODE_V2_MIN_VERSION = "2.4.0"

const OPENCODE_V2_NOTICE_TITLE = "Oh My OpenAgent on OpenCode 2"

export const OPENCODE_V2_NOTICE_DURATION_MS = 15_000

export function buildUnsupportedHostNotice(found: string): { title: string; message: string } {
  return {
    title: OPENCODE_V2_NOTICE_TITLE,
    message: [
      `This plugin does not support OpenCode ${found}.`,
      `OpenCode ${OPENCODE_V2_MIN_VERSION} or a newer 2.x release is required.`,
    ].join("\n"),
  }
}
