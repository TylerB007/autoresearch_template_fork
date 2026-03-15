import { useState, useRef, useEffect, type ReactNode } from 'react';

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
}

export default function Tooltip({ content, children }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<'above' | 'below'>('above');
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (visible && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      // If not enough space above, show below
      setPosition(rect.top < 120 ? 'below' : 'above');
    }
  }, [visible]);

  return (
    <span
      ref={triggerRef}
      className="relative inline-flex items-center"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      {visible && (
        <div
          ref={tooltipRef}
          className={`absolute z-50 w-64 rounded-2xl border border-white/10 bg-[#0b1526] px-3 py-2.5 text-xs shadow-[0_18px_40px_rgba(2,8,23,0.65)] ${
            position === 'above' ? 'bottom-full mb-2' : 'top-full mt-2'
          } right-0`}
        >
          {content}
        </div>
      )}
    </span>
  );
}
