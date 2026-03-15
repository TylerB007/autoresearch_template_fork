import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  CartesianGrid,
} from 'recharts';

interface FeeChartProps {
  data: Array<{ t: number; cumulativeUsd: number }>;
  rebalanceTimestamps?: number[];
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatUsd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value > 0) return `$${value.toFixed(4)}`;
  return '$0.00';
}

export default function FeeChart({ data, rebalanceTimestamps = [] }: FeeChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-slate-500">
        No fee data available yet
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(126, 163, 190, 0.14)" vertical={false} />
        <XAxis
          dataKey="t"
          tickFormatter={formatDate}
          stroke="#7f95ab"
          fontSize={11}
          tickLine={false}
        />
        <YAxis
          tickFormatter={(v) => formatUsd(v)}
          stroke="#7f95ab"
          fontSize={11}
          tickLine={false}
          width={70}
        />
        <Tooltip
          contentStyle={{ backgroundColor: '#0e1823', border: '1px solid rgba(126, 163, 190, 0.18)', borderRadius: '16px', boxShadow: '0 16px 40px rgba(0,0,0,0.35)' }}
          labelStyle={{ color: '#d8e4f0' }}
          labelFormatter={(ts) => new Date(ts as number).toLocaleString()}
          formatter={(value: number | undefined) => [formatUsd(value ?? 0), 'Cumulative Fees']}
        />
        {rebalanceTimestamps.map((ts, i) => (
          <ReferenceLine
            key={i}
            x={ts}
            stroke="#73b8ff"
            strokeDasharray="4 4"
            strokeWidth={1}
          />
        ))}
        <Line
          type="monotone"
          dataKey="cumulativeUsd"
          stroke="#55d6a7"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: '#55d6a7' }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
