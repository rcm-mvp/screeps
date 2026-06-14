/** Tiny canvas sparkline for the header CPU readout. */

import { useEffect, useRef } from 'react';

export function Sparkline({
  values,
  limit,
  width = 120,
  height = 28,
}: {
  values: number[];
  /** Reference line (CPU limit); points above it draw red. */
  limit?: number;
  width?: number;
  height?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    if (values.length < 2) return;

    const max = Math.max(...values, limit ?? 0) * 1.1 || 1;
    const x = (i: number) => (i / (values.length - 1)) * (width - 2) + 1;
    const y = (v: number) => height - 2 - (v / max) * (height - 4);

    if (limit !== undefined) {
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y(limit));
      ctx.lineTo(width, y(limit));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.strokeStyle = '#5ec8f2';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    values.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))));
    ctx.stroke();

    if (limit !== undefined) {
      ctx.fillStyle = '#ff5050';
      values.forEach((v, i) => {
        if (v > limit) ctx.fillRect(x(i) - 1, y(v) - 1, 2, 2);
      });
    }
  }, [values, limit, width, height]);

  return <canvas ref={ref} width={width} height={height} className="sparkline" />;
}
