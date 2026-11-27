// The registration plan (task 23 of the opencode-v2-compat plan): the plain
// JSON projection the V1 config pipeline produces over the task-22 base.
// Every value is structured-cloneable (no functions, no class instances) so
// the plan can cross the host boundary and be replayed as data by the
// synchronous transforms of tasks 24 to 28.

export type PlanAgentConfig = {
  readonly prompt?: string
  readonly mode?: string
  readonly model?: string
  readonly description?: string
  readonly hidden?: boolean
  readonly tools?: Readonly<Record<string, boolean>>
  readonly permission?: Readonly<Record<string, unknown>>
  readonly [key: string]: unknown
}

export type PlanServerConfig = {
  readonly type?: string
  readonly command?: ReadonlyArray<string>
  readonly url?: string
  readonly enabled?: boolean
  readonly [key: string]: unknown
}

export type PlanCommandConfig = {
  readonly template?: string
  readonly description?: string
  readonly agent?: string
  readonly model?: string
  readonly [key: string]: unknown
}

export type PlanSection<T> = {
  readonly added: Readonly<Record<string, T>>
  readonly modified: Readonly<Record<string, T>>
  readonly removed: readonly string[]
}

export type RegistrationPlan = {
  readonly agents: PlanSection<PlanAgentConfig>
  readonly defaultAgent?: string
  readonly tools: Readonly<Record<string, boolean>>
  readonly mcp: PlanSection<PlanServerConfig>
  readonly commands: PlanSection<PlanCommandConfig>
  readonly provider: Readonly<Record<string, unknown>>
  readonly model?: string
}

// The nothing-applied baseline the first recompute compares against: a domain
// reloads only when its plan section differs from the last applied section.
export const EMPTY_PLAN: RegistrationPlan = {
  agents: { added: {}, modified: {}, removed: [] },
  tools: {},
  mcp: { added: {}, modified: {}, removed: [] },
  commands: { added: {}, modified: {}, removed: [] },
  provider: {},
}

export type PlanDomain = "agents" | "tools" | "mcp" | "commands" | "provider" | "model"
