interface MetricCardProps {
  label: string;
  value: string;
  subValue?: string;
  color?: 'green' | 'red' | 'yellow' | 'blue' | 'white';
  size?: 'sm' | 'md';
  tone?: 'success' | 'warning' | 'danger' | 'accent' | 'neutral';
}

const colorClasses = {
  green: 'text-theme-success',
  red: 'text-theme-danger',
  yellow: 'text-theme-warning',
  blue: 'text-theme-accent',
  white: 'text-theme-primary',
};

const toneBorder: Record<string, string> = {
  success: 'border-l-2 border-emerald-500/40',
  warning: 'border-l-2 border-amber-500/40',
  danger:  'border-l-2 border-rose-500/40',
  accent:  'border-l-2 border-sky-500/40',
  neutral: '',
};

export default function MetricCard({ label, value, subValue, color = 'white', size = 'md', tone = 'neutral' }: MetricCardProps) {
  const valueSize = size === 'md' ? 'metric-card-value' : 'text-base font-semibold leading-tight';

  return (
    <div className={`metric-card animate-fade-rise ${toneBorder[tone]}`}>
      <p className="metric-card-label">{label}</p>
      <p className={`${valueSize} ${colorClasses[color]} text-data`}>{value}</p>
      {subValue && <p className="metric-card-subvalue">{subValue}</p>}
    </div>
  );
}
