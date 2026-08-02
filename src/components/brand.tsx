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
        "inline-flex items-center font-semibold tracking-[-0.045em]",
        compact ? "text-xl" : "text-[1.7rem]",
        className
      )}
      aria-label="OpenVac 首页"
    >
      <span>OpenVac</span>
    </Link>
  );
}
