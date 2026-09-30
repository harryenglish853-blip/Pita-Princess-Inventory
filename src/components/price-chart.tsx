"use client";
import { useState } from "react";
import { money, dateFmt } from "@/lib/format";

/** Single-series price trend (per inventory unit). Hover a point for its value; the table next to it is the accessible view. */
export function PriceChart({ points, unit }: { points: { at: string; price: number; vendor?: string | null }[]; unit: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return <p className="text-sm text-muted">Price trend appears after two or more receipts.</p>;
  const W = 560, H = 180, P = { l: 56, r: 16, t: 12, b: 28 };
  const xs = points.map((p) => new Date(p.at).getTime());
  const ys = points.map((p) => p.price);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo || hi * 0.1 || 1) * 0.15;
  const minY = Math.max(0, lo - pad), maxY = hi + pad;
  const x = (t: number) => P.l + ((t - minX) / (maxX - minX || 1)) * (W - P.l - P.r);
  const y = (v: number) => P.t + (1 - (v - minY) / (maxY - minY || 1)) * (H - P.t - P.b);
  const ticks = [minY, (minY + maxY) / 2, maxY];
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(xs[i]).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ");
  const h = hover !== null ? points[hover] : null;
  return (
    <figure className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Price per ${unit} over time`} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={P.l - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{money(t)}</text>
          </g>
        ))}
        <text x={P.l} y={H - 8} fontSize="11" fill="var(--muted)">{dateFmt(points[0].at)}</text>
        <text x={W - P.r} y={H - 8} fontSize="11" fill="var(--muted)" textAnchor="end">{dateFmt(points[points.length - 1].at)}</text>
        <path d={path} fill="none" stroke="var(--brand)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {hover !== null ? <line x1={x(xs[hover])} x2={x(xs[hover])} y1={P.t} y2={H - P.b} stroke="var(--border-strong)" strokeDasharray="3 3" /> : null}
        {points.map((p, i) => (
          <g key={i} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0}>
            <circle cx={x(xs[i])} cy={y(p.price)} r={14} fill="transparent" />
            <circle cx={x(xs[i])} cy={y(p.price)} r={4} fill="var(--brand)" stroke="var(--surface)" strokeWidth={2} />
          </g>
        ))}
      </svg>
      {h ? (
        <div className="pointer-events-none absolute left-2 top-0 rounded-md border border-border bg-surface px-2 py-1 text-xs shadow">
          <div className="font-semibold">{money(h.price, { precise: true })} / {unit}</div>
          <div className="text-muted">{dateFmt(h.at)}{h.vendor ? ` · ${h.vendor}` : ""}</div>
        </div>
      ) : null}
    </figure>
  );
}
