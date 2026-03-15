import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';

interface DailyEarningsChartProps {
  data: Array<{ date: string; feesUsd: number }>;
}

function formatDate(dateStr: string): string {
  const [, month, day] = dateStr.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(month, 10) - 1]} ${parseInt(day, 10)}`;
}

function formatUsd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value > 0) return `$${value.toFixed(4)}`;
  return '$0.00';
}

export default function DailyEarningsChart({ data }: DailyEarningsChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-slate-500">
        No fee data available yet
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(126, 163, 190, 0.14)" vertical={false} />
        <XAxis
          dataKey="date"
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
          labelFormatter={(date) => formatDate(date as string)}
          formatter={(value: number | undefined) => [formatUsd(value ?? 0), 'Fees Collected']}
        />
        <Bar dataKey="feesUsd" fill="#55d6a7" radius={[10, 10, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
