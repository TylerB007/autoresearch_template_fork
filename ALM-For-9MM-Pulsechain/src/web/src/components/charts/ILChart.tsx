import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  CartesianGrid,
} from 'recharts';

interface ILChartProps {
  data: Array<{ t: number; ilPercent: number }>;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function ILChart({ data }: ILChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-slate-500">
        No IL data available yet
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={data} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(126, 163, 190, 0.14)" vertical={false} />
        <XAxis
          dataKey="t"
          tickFormatter={formatDate}
          stroke="#7f95ab"
          fontSize={11}
          tickLine={false}
        />
        <YAxis
          tickFormatter={(v) => `${v.toFixed(2)}%`}
          stroke="#7f95ab"
          fontSize={11}
          tickLine={false}
          width={60}
        />
        <Tooltip
          contentStyle={{ backgroundColor: '#0e1823', border: '1px solid rgba(126, 163, 190, 0.18)', borderRadius: '16px', boxShadow: '0 16px 40px rgba(0,0,0,0.35)' }}
          labelStyle={{ color: '#d8e4f0' }}
          labelFormatter={(ts) => new Date(ts as number).toLocaleString()}
          formatter={(value: number | undefined) => [`${(value ?? 0).toFixed(4)}%`, 'Impermanent Loss']}
        />
        <ReferenceLine y={0} stroke="#7f95ab" strokeDasharray="3 3" />
        <Area
          type="monotone"
          dataKey="ilPercent"
          stroke="#ff7f88"
          fill="#ff7f88"
          fillOpacity={0.18}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: '#ff7f88' }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
