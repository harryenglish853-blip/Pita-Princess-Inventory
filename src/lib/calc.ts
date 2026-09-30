/**
 * Safe arithmetic for count inputs ("3*12+4", "2.5 + 1/2"). No eval: a tiny
 * recursive-descent parser supporting + - * / parentheses and decimals.
 * Returns null for anything that is not a valid, finite, non-negative expression.
 */
export function evaluate(input: string): number | null {
  const src = input.replace(/\s+/g, "").replace(/,/g, "");
  if (!src) return null;
  let i = 0;
  const peek = () => src[i];
  function num(): number {
    const m = /^\d*\.?\d+|^\d+\.?/.exec(src.slice(i));
    if (!m) throw new Error("number expected");
    i += m[0].length;
    return Number(m[0]);
  }
  function factor(): number {
    if (peek() === "(") { i++; const v = expr(); if (peek() !== ")") throw new Error(") expected"); i++; return v; }
    if (peek() === "-") { i++; return -factor(); }
    return num();
  }
  function term(): number {
    let v = factor();
    while (peek() === "*" || peek() === "x" || peek() === "/") {
      const op = src[i++];
      const r = factor();
      if (op === "/") { if (r === 0) throw new Error("divide by zero"); v /= r; } else v *= r;
    }
    return v;
  }
  function expr(): number {
    let v = term();
    while (peek() === "+" || peek() === "-") { const op = src[i++]; const r = term(); v = op === "+" ? v + r : v - r; }
    return v;
  }
  try {
    const v = expr();
    if (i !== src.length || !Number.isFinite(v)) return null;
    return Math.round(v * 10000) / 10000;
  } catch {
    return null;
  }
}

export const isExpression = (s: string) => /[+*/x()]|.-/.test(s.trim());
