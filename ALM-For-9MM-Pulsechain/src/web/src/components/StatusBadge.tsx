interface StatusBadgeProps {
  inRange: boolean;
}

export default function StatusBadge({ inRange }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-[11px] font-semibold tracking-[0.18em] ${
        inRange
          ? 'border border-emerald-400/25 bg-emerald-500/10 text-emerald-300'
          : 'border border-rose-400/25 bg-rose-500/10 text-rose-300'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${inRange ? 'bg-emerald-300' : 'bg-rose-300'}`} />
      {inRange ? 'IN RANGE' : 'OUT OF RANGE'}
    </span>
  );
}
