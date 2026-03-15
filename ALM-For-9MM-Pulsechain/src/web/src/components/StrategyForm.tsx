import React, { useState } from 'react';

export const STRATEGY_OPTIONS = [
  { value: 'center_3pct', label: 'Center ~3% (Neutral, Tight)' },
  { value: 'center_6pct', label: 'Center ~6% (Neutral, Wide)' },
  { value: 'center', label: 'Center (Neutral, Custom Width)' },
  { value: 'bullish_3pct', label: 'Bullish ~3% (30/70 Split, Tight)' },
  { value: 'bullish_6pct', label: 'Bullish ~6% (30/70 Split, Wide)' },
  { value: 'bullish', label: 'Bullish (Custom Width)' },
  { value: 'bearish_3pct', label: 'Bearish ~3% (70/30 Split, Tight)' },
  { value: 'bearish_6pct', label: 'Bearish ~6% (70/30 Split, Wide)' },
  { value: 'bearish', label: 'Bearish (Custom Width)' },
  { value: 'lazy_up', label: 'Lazy Up (Rebalance on Pump Only)' },
  { value: 'lazy_down', label: 'Lazy Down (Rebalance on Dump Only)' },
  { value: 'static', label: 'Static (Monitor Only)' },
] as const;

export const STRATEGY_LABELS: Record<string, string> = Object.fromEntries(
  STRATEGY_OPTIONS.map((o) => [o.value, o.label])
);

/** Check if strategy has preset width (e.g., center_3pct, pulse_300) */
const HAS_PRESET_WIDTH = /^.+_(\d+)(pct)?$/;

export interface StrategyFormData {
  token_id: number;
  strategy: string;
  width_ticks: number;
  trigger_distance_ticks: number;
}

interface StrategyFormProps {
  initialData?: Partial<StrategyFormData>;
  showTokenId?: boolean;
  onSubmit: (data: StrategyFormData) => void;
  onCancel: () => void;
  submitLabel?: string;
}

export default function StrategyForm({
  initialData,
  showTokenId = true,
  onSubmit,
  onCancel,
  submitLabel = 'Save',
}: StrategyFormProps) {
  const [tokenId, setTokenId] = useState(initialData?.token_id ?? 0);
  const [strategy, setStrategy] = useState(initialData?.strategy ?? 'center_3pct');
  const [widthTicks, setWidthTicks] = useState(initialData?.width_ticks ?? 300);
  const [triggerDistance, setTriggerDistance] = useState(initialData?.trigger_distance_ticks ?? 10);

  const hasPresetWidth = HAS_PRESET_WIDTH.test(strategy);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      token_id: tokenId,
      strategy,
      width_ticks: hasPresetWidth ? 0 : widthTicks,
      trigger_distance_ticks: triggerDistance,
    });
  };

  const inputClass = 'field-input';
  const labelClass = 'field-label';

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {showTokenId && (
        <div>
          <label className={labelClass}>Token ID</label>
          <input
            type="number"
            value={tokenId || ''}
            onChange={(e) => setTokenId(Number(e.target.value))}
            className={inputClass}
            required
            min={1}
          />
        </div>
      )}
      <div>
        <label className={labelClass}>Strategy</label>
        <select
          value={strategy}
          onChange={(e) => setStrategy(e.target.value)}
          className={inputClass}
        >
          {STRATEGY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={labelClass}>Width (ticks)</label>
        {hasPresetWidth ? (
          <div className="field-input flex items-center text-sm text-slate-400">
            Built-in preset (strategy includes width)
          </div>
        ) : (
          <input
            type="number"
            value={widthTicks}
            onChange={(e) => setWidthTicks(Number(e.target.value))}
            className={inputClass}
            required
            min={1}
          />
        )}
      </div>
      <div>
        <label className={labelClass}>Trigger Distance (ticks)</label>
        <input
          type="number"
          value={triggerDistance}
          onChange={(e) => setTriggerDistance(Number(e.target.value))}
          className={inputClass}
          required
          min={1}
        />
      </div>
      <div className="flex flex-col gap-3 pt-2 sm:flex-row">
        <button
          type="submit"
          className="action-button action-button-primary flex-1"
        >
          {submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="action-button action-button-secondary flex-1"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
