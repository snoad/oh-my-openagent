// The real OpenCode 2 SDK item types and the named brand helpers for the
// provider and model registration (task 28 repair). The pinned 2.4.1
// @opencode/schema makes every registration item field required (Model.Info
// carries time.released, cost, status, enabled, limit, capabilities, variants;
// Provider.Info carries activation and package), so the registration mirrors
// the host items through the real SDK types (root type import, the sanctioned
// PLUGIN-RUNTIME-IMPORTS branch) instead of hand-written optional-field
// mirrors that cannot catch a missing required field at compile time. The
// effect string brands cross through one named helper per brand.

import type { Model, Provider } from "@opencode/plugin"

// Mutable item views for the editor update callbacks: the pinned host editors
// hand Types.DeepMutable items, and the registration writes top-level fields.
export type MutableModelInfo = { -readonly [K in keyof Model.Info]: Model.Info[K] }
export type MutableProviderInfo = { -readonly [K in keyof Provider.Info]: Provider.Info[K] }

// The USD-per-million-tokens money brand of the Model.Info cost table.
export type MoneyUSDPerMillion = Model.Info["cost"][number]["input"]

export function modelIDBrand(id: string): Model.ID {
  return id as Model.ID
}

export function providerIDBrand(id: string): Provider.ID {
  return id as Provider.ID
}

export function moneyUSDPerMillion(value: number): MoneyUSDPerMillion {
  return value as MoneyUSDPerMillion
}
