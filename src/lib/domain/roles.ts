import type { Role } from "./types";

/**
 * Capabilities per administrative role.
 *
 * This describes intended policy so UI and documentation stay aligned.
 * It is NOT an enforcement mechanism: every capability must be checked on the
 * server (and in database policies) once a backend exists. Client code may
 * only use it to decide what to show.
 */
export type Capability =
  | "admin.users.manage"
  | "admin.groups.manage"
  | "admin.permissions.manage"
  | "assistants.configure"
  | "knowledge.upload"
  | "knowledge.manage"
  | "chat.use";

export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  system_admin: [
    "admin.users.manage",
    "admin.groups.manage",
    "admin.permissions.manage",
    "assistants.configure",
    "knowledge.upload",
    "knowledge.manage",
    "chat.use",
  ],
  assistant_manager: [
    "assistants.configure",
    "knowledge.upload",
    "knowledge.manage",
    "chat.use",
  ],
  employee: ["chat.use"],
};

export function roleHas(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

/** Whether the role should see the administration area at all. */
export function canSeeAdministration(role: Role): boolean {
  return role === "system_admin" || role === "assistant_manager";
}
