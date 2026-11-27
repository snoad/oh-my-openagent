import { type LiveCheckContext, type LivePluginState } from "./live-check-context"

// Sandbox API helpers for the live parity runner (plan task 20): the
// authenticated GET wrapper and the bounded wait for the plugin's active
// state. The observed GET /api/plugin shape on 2.4.1 is
// { location, data: [{id, source, features, state: { status } }] }.

export async function apiJson(ctx: LiveCheckContext, path: string): Promise<unknown> {
  try {
    const response = await fetch(`${ctx.apiBase}${path}`, {
      headers: { authorization: `Basic ${btoa(`opencode:${ctx.password}`)}` },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) return undefined
    return (await response.json()) as unknown
  } catch {
    return undefined
  }
}

export type ListedPluginEntry = { id: string; status: string; raw: string }

function pluginEntryOf(body: unknown, pluginId: string): ListedPluginEntry | undefined {
  if (body === null || typeof body !== "object") return undefined
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return undefined
  for (const entry of data) {
    if (entry === null || typeof entry !== "object") continue
    const record = entry as { id?: unknown; state?: { status?: unknown } }
    if (record.id !== pluginId) continue
    const status = record.state?.status
    return {
      id: String(record.id),
      status: typeof status === "string" ? status : "",
      raw: JSON.stringify(entry),
    }
  }
  return undefined
}

export async function awaitPluginActive(
  ctx: LiveCheckContext,
  pluginId: string,
  timeoutMs: number,
): Promise<LivePluginState> {
  const startedAt = Date.now()
  let entryText = ""
  for (;;) {
    const entry = pluginEntryOf(await apiJson(ctx, "/api/plugin"), pluginId)
    if (entry !== undefined) entryText = entry.raw
    if (entry?.status === "active") {
      return { active: true, waitedMs: Date.now() - startedAt, entryText }
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return { active: false, waitedMs: Date.now() - startedAt, entryText }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}
