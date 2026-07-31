import Link from "next/link";
import { cn } from "@/lib/utils";

export function Brand({
  compact = false,
  className
}: {
  compact?: boolean;
  className?: string;
}) {
  return (
    <Link
      href="/"
      className={cn(
        "inline-flex items-center gap-2 font-semibold tracking-[-0.035em]",
        compact ? "text-xl" : "text-[1.7rem]",
        className
      )}
      aria-label="OpenVac 首页"
    >
      <span
        aria-hidden
        className="h-2.5 w-2.5 rounded-full bg-[var(--accent)]"
      />
      <span>OpenVac</span>
    </Link>
  );
}
