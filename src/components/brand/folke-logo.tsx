import Image from "next/image";

import { cn } from "@/lib/utils";

/**
 * Folke brand marks, rendered from the original files in design/assets
 * (copied unchanged to public/brand). Never redraw or recolour the logo.
 */

const LOGO_RATIO = 425.9 / 142.58;
const SYMBOL_RATIO = 136.12 / 142.58;

interface FolkeLogoProps {
  /** Rendered height in px. */
  height?: number;
  /** Show the discreet "by Börjessons" endorsement (login + start page only). */
  endorsement?: boolean;
  priority?: boolean;
  className?: string;
}

export function FolkeLogo({
  height = 24,
  endorsement = false,
  priority = false,
  className,
}: FolkeLogoProps) {
  const width = Math.round(height * LOGO_RATIO);
  return (
    <span className={cn("inline-flex flex-col items-end", className)}>
      <Image
        src="/brand/folke-logo.svg"
        alt="Folke"
        width={width}
        height={height}
        priority={priority}
        unoptimized
        className="block"
        style={{ width, height }}
      />
      {endorsement && (
        <span
          className="mt-1 leading-none font-medium tracking-[0.01em] whitespace-nowrap text-subtle-foreground"
          style={{ fontSize: Math.min(12, Math.max(10, height * 0.38)) }}
        >
          by Börjessons
        </span>
      )}
    </span>
  );
}

export function FolkeSymbol({
  size = 24,
  className,
}: {
  size?: number;
  className?: string;
}) {
  const width = Math.round(size * SYMBOL_RATIO);
  return (
    <Image
      src="/brand/folke-symbol.svg"
      alt=""
      aria-hidden
      width={width}
      height={size}
      unoptimized
      className={cn("block", className)}
      style={{ width, height: size }}
    />
  );
}
