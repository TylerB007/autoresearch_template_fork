interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className = '' }: SkeletonProps) {
  return <div aria-hidden="true" className={`skeleton-block ${className}`} />;
}

export function MetricCardSkeleton() {
  return (
    <div className="metric-card">
      <Skeleton className="mb-3 h-3 w-24 rounded-full" />
      <Skeleton className="h-8 w-28 rounded-2xl" />
      <div className="mt-auto space-y-2">
        <Skeleton className="h-3 w-32 rounded-full" />
        <Skeleton className="h-3 w-20 rounded-full" />
      </div>
    </div>
  );
}

export function PositionCardSkeleton() {
  return (
    <div className="panel p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Skeleton className="h-3 w-12 rounded-full" />
            <Skeleton className="h-4 w-8 rounded-full" />
          </div>
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
        <Skeleton className="h-6 w-20 rounded-full" />
      </div>
      {/* Strategy + value row */}
      <div className="flex items-center justify-between mb-3">
        <Skeleton className="h-3 w-20 rounded-full" />
        <div className="flex gap-3">
          <Skeleton className="h-3 w-14 rounded-full" />
          <Skeleton className="h-3 w-16 rounded-full" />
        </div>
      </div>
      {/* Metrics grid */}
      <div className="grid grid-cols-4 gap-2 mb-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="space-y-1">
            <Skeleton className="h-2.5 w-14 rounded-full" />
            <Skeleton className="h-4 w-10 rounded-full" />
          </div>
        ))}
      </div>
      {/* Range bar */}
      <Skeleton className="h-8 w-full rounded-2xl" />
    </div>
  );
}
