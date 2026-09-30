"use client";

import { ChevronsUpDown, LogOut, Settings, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { UserAvatar } from "@/components/common/user-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface UserMenuUser {
  name: string;
  email: string;
  roleLabel: string;
  canAdminister: boolean;
}

export function UserMenu({ user }: { user: UserMenuUser }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:bg-sidebar-accent">
        <UserAvatar name={user.name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{user.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {user.roleLabel}
          </span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-subtle-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
        <DropdownMenuLabel className="font-normal">
          <span className="block text-sm font-medium text-foreground">{user.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link href="/settings">
              <Settings />
              Inställningar
            </Link>
          </DropdownMenuItem>
          {user.canAdminister && (
            <DropdownMenuItem asChild>
              <Link href="/admin/users">
                <ShieldCheck />
                Administration
              </Link>
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          {/* Prototype: returns to the login view; there is no session to end. */}
          <Link href="/login">
            <LogOut />
            Logga ut
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
