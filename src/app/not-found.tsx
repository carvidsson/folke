import Link from "next/link";

import { FolkeLogo } from "@/components/brand/folke-logo";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6 text-center">
      <FolkeLogo height={28} />
      <div>
        <h1 className="text-title">Sidan hittades inte</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Sidan finns inte eller så saknar du behörighet att se den.
        </p>
      </div>
      <Button asChild variant="outline">
        <Link href="/">Till startsidan</Link>
      </Button>
    </div>
  );
}
