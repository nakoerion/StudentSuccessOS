import { GraduationCap } from "lucide-react";

export function BrandMark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex size-8 items-center justify-center rounded-lg bg-brand text-brand-foreground shadow-sm ${className}`}
    >
      <GraduationCap className="size-4.5" aria-hidden />
    </span>
  );
}
