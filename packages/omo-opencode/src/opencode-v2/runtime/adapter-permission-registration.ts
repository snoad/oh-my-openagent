import { permissionStep } from "../registration/permissions"
import type { V2AdapterRegistration } from "./adapters"

// Plan task 27: the permission step joins the task-23 plan source. The
// per-agent rules are already complete on the agent items (the task-24
// builder renders them through the one owner in registration/permissions.ts
// with the plan's global tools map), so this step carries no editor work: it
// reports the plan's unmappable glob tool rules once per registration
// (LIM-15). The request-level hiding of the same rules lives in
// hooks/hidden-tools.ts, wired into the context hook adapter by adapters.ts.
export const v2PermissionRegistrationAdapter: V2AdapterRegistration = {
  id: "v2-permission-registration",
  register: ({ runtime }) => {
    const source = runtime.planSource
    if (source === undefined) return
    source.registerStep(permissionStep())
  },
}
