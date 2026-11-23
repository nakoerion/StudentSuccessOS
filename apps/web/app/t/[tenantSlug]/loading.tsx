import { Skeleton } from "../../../components/page";

/** Skeleton shown inside the shell while a school page loads (never a bare full-page spinner). */
export default function Loading() {
  return (
    <div className="flex flex-col gap-6" data-testid="page-loading" aria-busy="true">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-2 w-full" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-72 max-w-full" />
          <Skeleton className="h-8 w-56" />
        </div>
      ))}
    </div>
  );
}
