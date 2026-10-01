import { redirect } from "next/navigation";

import { requireAdministrationAccess } from "@/server/auth/session";

export default async function AdminIndexPage() {
  const { user } = await requireAdministrationAccess();
  redirect(user.role === "system_admin" ? "/admin/users" : "/admin/assistants");
}
