import type { ReactElement } from "react";

/**
 * Floor glow drawn under a piece of equipment (or desk) that an agent is using right now: a soft pulsing pool of light, a
 * ring that breathes and three sparks that rise, so the viewer sees at a glance which item is in use. CSS animations live
 * in styles.css (.fx-glow*) and are switched off for reduced motion.
 */
export function ActiveGlow({ x, y, rx = 34, ry = 15, color = "#74e0ff" }: { x: number; y: number; rx?: number; ry?: number; color?: string }): ReactElement {
  return (
    <g className="fx-glow" data-active-glow="1" transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`} pointerEvents="none">
      <ellipse className="fx-glow-pool" cx={0} cy={0} rx={rx} ry={ry} fill={color} />
      <ellipse className="fx-glow-ring" cx={0} cy={0} rx={rx * 0.8} ry={ry * 0.8} fill="none" stroke={color} strokeWidth={1.6} />
      {[-0.45, 0, 0.45].map((k, i) => (
        <circle key={i} className="fx-glow-spark" cx={rx * k} cy={-2} r={1.7} fill="#fff" style={{ animationDelay: `${-i * 0.55}s` }} />
      ))}
    </g>
  );
}
