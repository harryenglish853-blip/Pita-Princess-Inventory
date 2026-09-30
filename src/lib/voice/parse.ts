/**
 * Voice count interpretation: "Chicken breast, one case and eight and a half pounds"
 * -> { product: Chicken Breast, breakdown: [1 CASE, 8.5 LB] }.
 * Pure function: works offline, unit tested, and never writes anything itself.
 * The caller shows the transcript + interpretation and asks for confirmation when
 * confidence is low.
 */

export type VoiceLine = {
  key: string;
  name: string;
  units: { unit_id: string; code: string; name?: string }[];
  inventory_unit_id: string;
};

export type VoiceResult = {
  transcript: string;
  line: VoiceLine | null;
  alternatives: VoiceLine[];
  breakdown: { unit_id: string; code: string; qty: number }[];
  matchScore: number;
  confidence: number;
  issues: string[];
};

const SMALL: Record<string, number> = {
  zero: 0, oh: 0, one: 1, a: 1, an: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, ate: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** Spoken unit words -> unit codes. */
const UNIT_WORDS: Record<string, string[]> = {
  LB: ["pound", "pounds", "lb", "lbs", "lb.", "pouns"],
  OZ: ["ounce", "ounces", "oz"],
  KG: ["kilo", "kilos", "kilogram", "kilograms", "kg"],
  G: ["gram", "grams"],
  GAL: ["gallon", "gallons", "gal"],
  QT: ["quart", "quarts", "qt"],
  PT: ["pint", "pints"],
  L: ["liter", "liters", "litre", "litres"],
  "FL OZ": ["fluid"],
  EA: ["each", "ea", "piece", "pieces", "pcs", "count", "unit", "units", "heads", "head"],
  DZ: ["dozen", "dozens"],
  CASE: ["case", "cases", "cs", "kase"],
  BAG: ["bag", "bags"],
  BOX: ["box", "boxes"],
  CTN: ["carton", "cartons"],
  PK: ["pack", "packs", "package", "packages", "sleeve", "sleeves"],
  BTL: ["bottle", "bottles"],
  CAN: ["can", "cans"],
  JUG: ["jug", "jugs"],
  KEG: ["keg", "kegs"],
  TUB: ["tub", "tubs"],
  BUNCH: ["bunch", "bunches"],
  ROLL: ["roll", "rolls"],
  PAN: ["pan", "pans"],
};

const FILLER = new Set(["and", "plus", "with", "of", "the", "um", "uh", "like", "we", "have", "got", "there", "is", "are", "about", "count"]);

const norm = (s: string) =>
  s.toLowerCase().replace(/(\d),(\d)/g, "$1$2").replace(/[^a-z0-9.\s/-]/g, " ").replace(/-/g, " ").replace(/\s+/g, " ").trim();

function unitCodeFor(word: string): string | null {
  for (const [code, words] of Object.entries(UNIT_WORDS)) if (words.includes(word)) return code;
  return null;
}

type Tok = { kind: "num"; value: number } | { kind: "unit"; code: string } | { kind: "word"; text: string };

/** Turns words into numbers ("eight and a half" -> 8.5, "twenty two" -> 22, "3/4" -> 0.75). */
export function tokenize(text: string): Tok[] {
  const words = norm(text).split(" ").filter(Boolean);
  const out: Tok[] = [];
  let i = 0;
  const isNumWord = (w: string | undefined) => w !== undefined && (w in SMALL || w === "hundred" || /^\d*\.?\d+$/.test(w) || /^\d+\/\d+$/.test(w));
  while (i < words.length) {
    const w = words[i];
    // "a half", "half", "a quarter", "three quarters"
    if ((w === "half" || w === "quarter") || ((w === "a" || w === "an") && (words[i + 1] === "half" || words[i + 1] === "quarter"))) {
      const word = w === "half" || w === "quarter" ? w : words[++i];
      const frac = word === "half" ? 0.5 : 0.25;
      // "eight and a half" -> attach to the previous number
      const last = out[out.length - 1];
      if (last?.kind === "word" && last.text === "and" && out[out.length - 2]?.kind === "num") {
        out.pop();
        (out[out.length - 1] as { value: number }).value += frac;
      } else if (last?.kind === "num") last.value += frac;
      else out.push({ kind: "num", value: frac });
      i++;
      continue;
    }
    if (isNumWord(w) && !((w === "a" || w === "an") && !isNumWord(words[i + 1]) && unitCodeFor(words[i + 1] ?? "") === null)) {
      // Accumulate a spoken number: "twenty two", "one hundred five", "2.5", "point five"
      let value = 0;
      let consumed = false;
      while (i < words.length && isNumWord(words[i])) {
        const t = words[i];
        if (/^\d+\/\d+$/.test(t)) { const [a, b] = t.split("/").map(Number); value += b ? a / b : 0; }
        else if (/^\d*\.?\d+$/.test(t)) value += Number(t);
        else if (t === "hundred") value = (value || 1) * 100;
        else if ((t === "to" || t === "too" || t === "for") && consumed) break; // "two to three" is ambiguous: stop
        else {
          const n = SMALL[t];
          // "twenty" followed by "two" adds; "one" after "one" starts a new number
          if (consumed && value % 10 === 0 && value >= 20 && n < 10) value += n;
          else if (consumed) break;
          else value += n;
        }
        consumed = true;
        i++;
        if (/^\d/.test(t)) break;
      }
      if (words[i] === "point" && /^\d+$|^(zero|one|two|three|four|five|six|seven|eight|nine)$/.test(words[i + 1] ?? "")) {
        const d = /^\d+$/.test(words[i + 1]) ? words[i + 1] : String(SMALL[words[i + 1]]);
        value += Number(`0.${d}`);
        i += 2;
      }
      out.push({ kind: "num", value });
      continue;
    }
    if (w === "point" && out[out.length - 1]?.kind === "num") { i++; continue; }
    const unit = unitCodeFor(w) ?? (w === "fluid" && words[i + 1]?.startsWith("ounce") ? (i++, "FL OZ") : null);
    if (unit) { out.push({ kind: "unit", code: unit }); i++; continue; }
    out.push({ kind: "word", text: w });
    i++;
  }
  return out;
}

const stem = (w: string) => w.replace(/(es|s)$/, "");

/** 0..1 similarity between the spoken product words and a product name. */
export function nameScore(spoken: string[], name: string): number {
  const target = norm(name).split(" ").filter((w) => w.length > 1 && !FILLER.has(w)).map(stem);
  const said = spoken.filter((w) => w.length > 1 && !FILLER.has(w)).map(stem);
  if (!target.length || !said.length) return 0;
  let hit = 0;
  for (const s of said) {
    if (target.includes(s)) hit += 1;
    else if (target.some((t) => t.startsWith(s) || s.startsWith(t))) hit += 0.7;
    else if (target.some((t) => lev(t, s) <= (Math.max(t.length, s.length) > 5 ? 2 : 1))) hit += 0.6;
  }
  const recall = hit / said.length;              // how much of what was said matches
  const coverage = Math.min(1, hit / Math.min(target.length, said.length)); // the words said cover the name's key words
  return Math.min(1, 0.6 * recall + 0.4 * coverage);
}

function lev(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/**
 * @param current  the line currently on screen; used when no product name is spoken ("twelve pounds").
 * @param speechConfidence  recognizer confidence (0..1) when available.
 */
export function parseVoiceCount(transcript: string, lines: VoiceLine[], current: VoiceLine | null, speechConfidence = 0.9): VoiceResult {
  const toks = tokenize(transcript);
  const issues: string[] = [];
  const firstNum = toks.findIndex((t) => t.kind === "num");
  const nameWords = toks.slice(0, firstNum === -1 ? toks.length : firstNum).filter((t): t is { kind: "word"; text: string } => t.kind === "word").map((t) => t.text);

  // Product
  let line: VoiceLine | null = null;
  let matchScore = 0;
  let alternatives: VoiceLine[] = [];
  if (nameWords.length) {
    const scored = lines.map((l) => ({ l, s: nameScore(nameWords, l.name) })).filter((x) => x.s > 0.3).sort((a, b) => b.s - a.s);
    if (scored.length) {
      line = scored[0].l; matchScore = scored[0].s;
      alternatives = scored.slice(1, 4).filter((x) => x.s >= scored[0].s - 0.15).map((x) => x.l);
      if (alternatives.length) issues.push("Several products sound similar");
    } else {
      issues.push(`No product matches "${nameWords.join(" ")}"`);
    }
  } else if (current) {
    line = current; matchScore = 0.95;
  } else {
    issues.push("Say the product name");
  }

  // Quantities: (number [unit]) pairs
  const breakdown: VoiceResult["breakdown"] = [];
  if (line) {
    const rest = toks.slice(firstNum === -1 ? toks.length : firstNum);
    for (let k = 0; k < rest.length; k++) {
      const t = rest[k];
      if (t.kind !== "num") continue;
      const next = rest[k + 1];
      let unit = line.units.find((u) => u.unit_id === line!.inventory_unit_id)!;
      if (next?.kind === "unit") {
        const u = line.units.find((x) => x.code === next.code) ?? (next.code === "EA" ? line.units.find((x) => x.unit_id === line!.inventory_unit_id) : undefined);
        if (u) unit = u;
        else issues.push(`${line.name} is not counted in ${next.code}`);
        k++;
      } else if (breakdown.length > 0) {
        // "two cases six" -> trailing number is in the smallest count unit
        unit = line.units.find((u) => u.unit_id === line!.inventory_unit_id)!;
      }
      if (!unit) continue;
      const existing = breakdown.find((b) => b.unit_id === unit.unit_id);
      if (existing) existing.qty += t.value;
      else breakdown.push({ unit_id: unit.unit_id, code: unit.code, qty: t.value });
    }
    if (!breakdown.length) issues.push("No quantity heard");
  }

  const confidence = Math.max(0, Math.min(1, speechConfidence * matchScore * (issues.length ? 0.7 : 1)));
  return { transcript, line, alternatives, breakdown, matchScore, confidence, issues };
}
