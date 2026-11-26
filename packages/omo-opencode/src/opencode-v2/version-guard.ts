import { OPENCODE_V2_MIN_VERSION } from "./startup-notice"

export type HostVersionInput = {
  readonly name?: string
  readonly version?: string
  readonly channel?: string
}

export type HostVersionRejectReason =
  "missing-version" | "unparseable" | "unsupported-major" | "below-floor" | "above-verified"

export type HostVersionSupport =
  | { readonly ok: true; readonly major: number; readonly minor: number; readonly patch: number }
  | { readonly ok: false; readonly reason: HostVersionRejectReason; readonly found: string }

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/

function requireFloorParts(floor: string): { readonly major: number; readonly minor: number } {
  const match = SEMVER_RE.exec(floor)
  if (match === null) {
    throw new Error(`OPENCODE_V2_MIN_VERSION must be a semver triple, got: ${floor}`)
  }
  return { major: Number(match[1]), minor: Number(match[2]) }
}

const MIN_FLOOR = requireFloorParts(OPENCODE_V2_MIN_VERSION)

// Pure host-version classifier for the OpenCode 2 entry seam. Supported means
// the pinned floor major with a minor at or above the floor minor; a major
// above the floor is "above-verified" (unsupported until that host is
// verified), any lower major is "unsupported-major".
export function parseHostVersion(input: HostVersionInput): HostVersionSupport {
  const version = input.version
  if (typeof version !== "string" || version.length === 0) {
    return { ok: false, reason: "missing-version", found: typeof version === "string" ? version : "" }
  }
  const match = SEMVER_RE.exec(version)
  if (match === null) {
    return { ok: false, reason: "unparseable", found: version }
  }
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (major > MIN_FLOOR.major) {
    return { ok: false, reason: "above-verified", found: version }
  }
  if (major < MIN_FLOOR.major) {
    return { ok: false, reason: "unsupported-major", found: version }
  }
  if (minor < MIN_FLOOR.minor) {
    return { ok: false, reason: "below-floor", found: version }
  }
  return { ok: true, major, minor, patch }
}
