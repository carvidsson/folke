import type {
  AssistantGrant,
  DocumentValidity,
  ID,
  KnowledgeDocument,
  UserGroup,
} from "./types";

/**
 * Pure access-resolution helpers.
 *
 * They express the *rules* (direct grant OR group grant) so the same logic can
 * later run server-side against real data. They do not authenticate anyone and
 * must never be the only check – see docs/ARCHITECTURE.md, "Authorisation".
 */

export function groupIdsForUser(userId: ID, groups: UserGroup[]): ID[] {
  return groups.filter((g) => g.memberIds.includes(userId)).map((g) => g.id);
}

export type AssistantAccessSource =
  | { via: "direct" }
  | { via: "group"; groupId: ID };

/** All reasons a user has access to an assistant (empty = no access). */
export function assistantAccessSources(
  userId: ID,
  assistantId: ID,
  grants: AssistantGrant[],
  groups: UserGroup[],
): AssistantAccessSource[] {
  const userGroupIds = new Set(groupIdsForUser(userId, groups));
  const sources: AssistantAccessSource[] = [];

  for (const grant of grants) {
    if (grant.assistantId !== assistantId) continue;
    if (grant.subject.type === "user" && grant.subject.userId === userId) {
      sources.push({ via: "direct" });
    }
    if (
      grant.subject.type === "group" &&
      userGroupIds.has(grant.subject.groupId)
    ) {
      sources.push({ via: "group", groupId: grant.subject.groupId });
    }
  }
  return sources;
}

export function accessibleAssistantIds(
  userId: ID,
  grants: AssistantGrant[],
  groups: UserGroup[],
): ID[] {
  const ids = new Set<ID>();
  for (const grant of grants) {
    if (
      assistantAccessSources(userId, grant.assistantId, [grant], groups)
        .length > 0
    ) {
      ids.add(grant.assistantId);
    }
  }
  return [...ids];
}

const EXPIRING_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Classify a document's validity period relative to `now`. */
export function documentValidity(
  doc: Pick<KnowledgeDocument, "validFrom" | "validUntil">,
  now: Date,
): DocumentValidity {
  const from = new Date(`${doc.validFrom}T00:00:00`);
  if (from.getTime() > now.getTime()) return "upcoming";
  if (!doc.validUntil) return "valid";

  const until = new Date(`${doc.validUntil}T23:59:59`);
  if (until.getTime() < now.getTime()) return "expired";
  if (until.getTime() - now.getTime() <= EXPIRING_WINDOW_DAYS * DAY_MS) {
    return "expiring";
  }
  return "valid";
}

/**
 * Whether members of a group can see a document through the group itself.
 * "organisation" documents follow assistant access; "restricted" documents
 * are never shared through groups.
 */
export function documentVisibleToGroup(
  doc: Pick<KnowledgeDocument, "visibility" | "assistantIds">,
  groupId: ID,
  grants: AssistantGrant[],
): boolean {
  switch (doc.visibility.type) {
    case "groups":
      return doc.visibility.groupIds.includes(groupId);
    case "restricted":
      return false;
    case "organisation":
      return grants.some(
        (g) =>
          doc.assistantIds.includes(g.assistantId) &&
          g.subject.type === "group" &&
          g.subject.groupId === groupId,
      );
  }
}
