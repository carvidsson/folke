import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

const SIZES = {
  sm: "size-6 text-[0.625rem]",
  md: "size-8 text-xs",
  lg: "size-12 text-base",
} as const;

export function UserAvatar({
  name,
  size = "md",
  className,
}: {
  name: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <Avatar className={cn(SIZES[size], className)}>
      <AvatarFallback className="bg-navy-100 font-medium text-navy-700">
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
