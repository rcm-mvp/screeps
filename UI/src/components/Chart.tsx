/** Thin React wrapper around uPlot with container-width resizing. */

import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export function Chart({
  options,
  data,
  height = 240,
}: {
  /** uPlot options minus width/height (managed here). Must be stable per mount. */
  options: Omit<uPlot.Options, 'width' | 'height'>;
  data: uPlot.AlignedData;
  height?: number;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    const el = elRef.current!;
    const plot = new uPlot(
      { ...options, width: el.clientWidth || 640, height } as uPlot.Options,
      dataRef.current,
      el,
    );
    plotRef.current = plot;
    const ro = new ResizeObserver(() => {
      plot.setSize({ width: el.clientWidth || 640, height });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
    // options/height intentionally fixed for the lifetime of the chart
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    plotRef.current?.setData(data);
  }, [data]);

  return <div ref={elRef} className="chart" />;
}
