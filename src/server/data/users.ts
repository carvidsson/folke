import "server-only";

import type { ID, User, UserGroup } from "@/lib/domain/types";

import { mockStore } from "./mock-store";

// Mock implementation. Replace with database queries (see docs/ARCHITECTURE.md).

export async function listUsers(): Promise<User[]> {
  return mockStore().users;
}

export async function getUser(id: ID): Promise<User | null> {
  return mockStore().users.find((u) => u.id === id) ?? null;
}

export async function listGroups(): Promise<UserGroup[]> {
  return mockStore().groups;
}
