"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Decimal from "decimal.js";
import { ChevronLeft, ChevronRight, List, Maximize2, Mic, MicOff, ScanLine, Minus, Plus, AlertTriangle, CheckCircle2, CloudOff, Clock } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { idb, STORES } from "@/lib/offline/idb";
import { enqueueEntry, flush, lineKey, subscribeSync, type LocalEntry, type SyncStatus } from "@/lib/offline/count-sync";
import { breakdownToBase, type UnitOption } from "@/lib/units";
import { evaluate } from "@/lib/calc";
import { parseVoiceCount, type VoiceLine, type VoiceResult } from "@/lib/voice/parse";
import { Badge, Button, cx, inputBase } from "@/components/ui";
import { useToast } from "@/components/client";
import { SyncIndicator } from "@/components/offline/sync-indicator";
import { BarcodeScanner } from "./barcode-scanner";

type Unit = { unit_id: string; code: string; name: string; factor: number };
type Line = {
  item_id: string; product_id: string; product_number: string; name: string; category: string | null;
  storage_location_id: string | null; shelf: string | null; sort_order: number; inventory_unit_id: string;
  units: Unit[]; barcodes: { barcode: string; unit_id: string | null }[];
};
type Session = { id: string; name: string; count_number: string; status: string; count_type: string; count_at: string; location_name: string; location_id: string };
type Sheet = { session: Session; storages: { id: string; name: string }[]; lines: Line[]; entries: ServerEntry[]; server_time: string };
type ServerEntry = {
  id: string; product_id: string; storage_location_id: string | null; quantity: number; breakdown: { unit_id: string; qty: number }[];
  revision: number; has_conflict: boolean; recount_requested: boolean; counted_by_name: string | null; counted_at: string; method: string; voice_transcript: string | null;
};
type Draft = Record<string, string>;

const keyOf = (s: string, l: { product_id: string; storage_location_id: string | null }) => lineKey(s, l.product_id, l.storage_location_id);

function toLocal(sessionId: string, e: ServerEntry): LocalEntry {
  return {
    key: lineKey(sessionId, e.product_id, e.storage_location_id), session_id: sessionId, product_id: e.product_id,
    storage_location_id: e.storage_location_id, quantity: Number(e.quantity), revision: e.revision, pending: false,
    breakdown: (e.breakdown ?? []).map((b) => ({ unit_id: b.unit_id, qty: String(b.qty) })),
    has_conflict: e.has_conflict, recount_requested: e.recount_requested, counted_by_name: e.counted_by_name,
    counted_at: e.counted_at, method: e.method, voice_transcript: e.voice_transcript,
  };
}

export function CountScreen({ sessionId, userName, canReview, canMapBarcode }: { sessionId: string; userName: string; canReview: boolean; canMapBarcode: boolean }) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const toast = useToast();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [source, setSource] = useState<"device" | "network" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [entries, setEntries] = useState<Record<string, LocalEntry>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [view, setView] = useState<"focus" | "list">("focus");
  const [area, setArea] = useState<string>("all");
  const [filter, setFilter] = useState<"all" | "uncounted" | "recount">("all");
  const [idx, setIdx] = useState(0);
  const [sync, setSync] = useState<SyncStatus>({ state: "synced", pending: 0 });
  const [voice, setVoice] = useState<{ listening: boolean; last?: VoiceResult; pending?: VoiceResult; undo?: { key: string; prev: LocalEntry | undefined } }>({ listening: false });
  const [scanOpen, setScanOpen] = useState(false);
  const [unknownCode, setUnknownCode] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const recognition = useRef<{ stop: () => void } | null>(null);
  const firstInput = useRef<HTMLInputElement | null>(null);

  // ------------------------------------------------------------ loading (device first, then network)
  const loadLocalEntries = useCallback(async () => {
    const local = await idb.byIndex<LocalEntry>(STORES.entries, "session_id", sessionId);
    setEntries((prev) => {
      const next = { ...prev };
      for (const e of local) next[e.key] = e;
      return next;
    });
  }, [sessionId]);

  const refreshFromServer = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc("get_count_sheet", { p_session: sessionId });
      if (error) { if (error.code) setLoadError(error.message); return false; }
      const s = data as Sheet;
      await idb.put(STORES.sheets, { session_id: sessionId, sheet: s, downloaded_at: new Date().toISOString() });
      setSheet(s); setSource("network"); setLoadError(null);
      // Server values win unless this device has unsynced changes for the line.
      const local = await idb.byIndex<LocalEntry>(STORES.entries, "session_id", sessionId);
      const localByKey = new Map(local.map((l) => [l.key, l]));
      const merged: Record<string, LocalEntry> = {};
      for (const e of s.entries) {
        const le = toLocal(sessionId, e);
        const mine = localByKey.get(le.key);
        if (mine?.pending || mine?.error) merged[le.key] = { ...mine, revision: mine.revision ?? le.revision, has_conflict: le.has_conflict, recount_requested: le.recount_requested };
        else { merged[le.key] = le; await idb.put(STORES.entries, le); }
      }
      for (const l of local) if (!merged[l.key] && (l.pending || l.error)) merged[l.key] = l;
      setEntries(merged);
      return true;
    } catch {
      return false;
    }
  }, [sessionId, supabase]);

  useEffect(() => {
    (async () => {
      const cached = await idb.get<{ sheet: Sheet }>(STORES.sheets, sessionId).catch(() => undefined);
      if (cached?.sheet) { setSheet(cached.sheet); setSource("device"); await loadLocalEntries(); }
      const ok = await refreshFromServer();
      if (!ok && !cached?.sheet) setLoadError((e) => e ?? "This count is not saved on this device and the server cannot be reached.");
    })();
    const unsub = subscribeSync(setSync);
    const onSynced = () => void loadLocalEntries();
    window.addEventListener("count-synced", onSynced);
    const poll = setInterval(() => { if (navigator.onLine && document.visibilityState === "visible") void refreshFromServer(); }, 20000);
    return () => { unsub(); window.removeEventListener("count-synced", onSynced); clearInterval(poll); };
  }, [sessionId, loadLocalEntries, refreshFromServer]);

  // ------------------------------------------------------------ derived
  const status = sheet?.session.status ?? "in_progress";
  const locked = ["posted", "cancelled", "reviewed"].includes(status);
  const reviewOnly = status === "awaiting_review";
  const storageName = useMemo(() => new Map((sheet?.storages ?? []).map((s) => [s.id, s.name])), [sheet]);
  const allLines = sheet?.lines ?? [];
  const lines = useMemo(() => allLines.filter((l) => {
    if (area !== "all" && (l.storage_location_id ?? "none") !== area) return false;
    const e = entries[keyOf(sessionId, l)];
    if (filter === "uncounted") return !e || e.cleared;
    if (filter === "recount") return !!e?.recount_requested || !!e?.has_conflict;
    return true;
  }), [allLines, area, filter, entries, sessionId]);
  const counted = allLines.filter((l) => { const e = entries[keyOf(sessionId, l)]; return e && !e.cleared && e.quantity !== null; }).length;
  const recountCount = allLines.filter((l) => entries[keyOf(sessionId, l)]?.recount_requested).length;
  const current = lines[Math.min(idx, Math.max(0, lines.length - 1))];
  useEffect(() => { if (idx >= lines.length && lines.length) setIdx(lines.length - 1); }, [lines.length, idx]);

  const editable = (l: Line) => {
    if (locked) return false;
    if (reviewOnly && !canReview) return !!entries[keyOf(sessionId, l)]?.recount_requested;
    return true;
  };

  function draftFor(l: Line): Draft {
    const k = keyOf(sessionId, l);
    if (drafts[k]) return drafts[k];
    const e = entries[k];
    const d: Draft = {};
    if (e && !e.cleared) for (const b of e.breakdown) d[b.unit_id] = String(b.qty);
    return d;
  }

  function totalOf(l: Line, d: Draft): { total: Decimal | null; invalid: boolean } {
    const parts: { unit_id: string; qty: string }[] = [];
    let invalid = false;
    for (const u of l.units) {
      const raw = d[u.unit_id];
      if (raw === undefined || raw.trim() === "") continue;
      const v = evaluate(raw);
      if (v === null || v < 0) { invalid = true; continue; }
      parts.push({ unit_id: u.unit_id, qty: String(v) });
    }
    if (!parts.length) return { total: null, invalid };
    return { total: breakdownToBase(l.units as UnitOption[], parts), invalid };
  }

  const setDraft = (l: Line, unitId: string, value: string) => {
    const k = keyOf(sessionId, l);
    setDrafts((prev) => ({ ...prev, [k]: { ...draftFor(l), ...prev[k], [unitId]: value } }));
  };

  // ------------------------------------------------------------ save one line (device first)
  const commit = useCallback(async (l: Line, opts?: { method?: string; transcript?: string; confidence?: number; draft?: Draft }) => {
    const k = keyOf(sessionId, l);
    const d = opts?.draft ?? drafts[k];
    if (!d || !editable(l)) return;
    const breakdown: { unit_id: string; qty: string }[] = [];
    for (const u of l.units) {
      const raw = d[u.unit_id];
      if (raw === undefined || raw.trim() === "") continue;
      const v = evaluate(raw);
      if (v === null || v < 0) { toast({ tone: "error", text: `${l.name}: "${raw}" is not a valid quantity` }); return; }
      breakdown.push({ unit_id: u.unit_id, qty: String(v) });
    }
    const e = entries[k];
    const same = e && !e.cleared && JSON.stringify(e.breakdown.map((b) => [b.unit_id, Number(b.qty)]).sort()) === JSON.stringify(breakdown.map((b) => [b.unit_id, Number(b.qty)]).sort());
    if (same && !opts?.method) { setDrafts((p) => { const n = { ...p }; delete n[k]; return n; }); return; }
    if (!breakdown.length && !e) { setDrafts((p) => { const n = { ...p }; delete n[k]; return n; }); return; }
    const total = breakdown.length ? breakdownToBase(l.units as UnitOption[], breakdown).toNumber() : null;
    await enqueueEntry(
      { session_id: sessionId, product_id: l.product_id, storage_location_id: l.storage_location_id, breakdown, clear: breakdown.length === 0,
        base_revision: e?.revision ?? null, method: opts?.method ?? "keypad", voice_transcript: opts?.transcript ?? null, voice_confidence: opts?.confidence ?? null },
      { quantity: total, counted_by_name: userName, counted_at: new Date().toISOString(), recount_requested: e?.recount_requested, has_conflict: e?.has_conflict },
    );
    const saved = await idb.get<LocalEntry>(STORES.entries, k);
    setEntries((p) => ({ ...p, [k]: saved! }));
    setDrafts((p) => { const n = { ...p }; delete n[k]; return n; });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, entries, sessionId, userName, locked, reviewOnly, canReview]);

  const go = async (delta: number) => {
    if (current) await commit(current);
    setIdx((i) => Math.max(0, Math.min(lines.length - 1, i + delta)));
    setTimeout(() => firstInput.current?.focus(), 30);
  };
  const jumpTo = (l: Line) => {
    setFilter("all");
    setArea(l.storage_location_id ?? "none");
    const inArea = allLines.filter((x) => (x.storage_location_id ?? "none") === (l.storage_location_id ?? "none"));
    setIdx(Math.max(0, inArea.findIndex((x) => x.item_id === l.item_id)));
    setView("focus");
  };

  // ------------------------------------------------------------ voice
  const voiceLines: VoiceLine[] = useMemo(() => {
    const ordered = [...allLines].sort((a, b) => Number(b.storage_location_id === current?.storage_location_id) - Number(a.storage_location_id === current?.storage_location_id));
    return ordered.map((l) => ({ key: l.item_id, name: l.name, units: l.units.map((u) => ({ unit_id: u.unit_id, code: u.code, name: u.name })), inventory_unit_id: l.inventory_unit_id }));
  }, [allLines, current?.storage_location_id]);

  const applyVoice = useCallback(async (r: VoiceResult, lineOverride?: VoiceLine) => {
    const vl = lineOverride ?? r.line;
    if (!vl) return;
    const l = allLines.find((x) => x.item_id === vl.key)!;
    if (!editable(l)) { toast({ tone: "error", text: `${l.name} cannot be changed right now` }); return; }
    const k = keyOf(sessionId, l);
    const prev = entries[k];
    const draft: Draft = {};
    for (const b of r.breakdown) draft[b.unit_id] = String(b.qty);
    await commit(l, { method: "voice", transcript: r.transcript, confidence: r.confidence, draft });
    setVoice((v) => ({ ...v, pending: undefined, last: { ...r, line: vl }, undo: { key: k, prev } }));
    jumpTo(l);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allLines, entries, commit, sessionId]);

  const handleTranscript = useCallback((text: string, speechConfidence: number) => {
    const cur = current ? voiceLines.find((v) => v.key === current.item_id) ?? null : null;
    const r = parseVoiceCount(text, voiceLines, cur, speechConfidence || 0.9);
    if (r.line && r.breakdown.length && r.confidence >= 0.85 && !r.issues.length) void applyVoice(r);
    else setVoice((v) => ({ ...v, pending: r }));
  }, [current, voiceLines, applyVoice]);

  function toggleVoice() {
    if (voice.listening) { recognition.current?.stop(); setVoice((v) => ({ ...v, listening: false })); return; }
    const W = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Ctor) { toast({ tone: "info", text: "Voice recognition is not available in this browser. Type the phrase in the voice box instead." }); setVoice((v) => ({ ...v, listening: false, pending: v.pending })); return; }
    const rec = new Ctor();
    rec.lang = "en-US"; rec.continuous = true; rec.interimResults = false;
    rec.onresult = (ev) => {
      const res = ev.results[ev.results.length - 1];
      if (res.isFinal) handleTranscript(res[0].transcript, res[0].confidence);
    };
    rec.onend = () => setVoice((v) => ({ ...v, listening: false }));
    rec.onerror = (ev) => { toast({ tone: "error", text: `Voice: ${ev.error}` }); setVoice((v) => ({ ...v, listening: false })); };
    rec.start();
    recognition.current = rec;
    setVoice((v) => ({ ...v, listening: true }));
  }

  async function undoVoice() {
    const u = voice.undo; if (!u) return;
    const l = allLines.find((x) => keyOf(sessionId, x) === u.key); if (!l) return;
    const draft: Draft = {};
    for (const b of u.prev?.breakdown ?? []) draft[b.unit_id] = b.qty;
    await commit(l, { method: "voice", transcript: "(undo)", draft: u.prev ? draft : {} });
    setVoice((v) => ({ ...v, undo: undefined, last: undefined }));
    toast({ tone: "info", text: "Voice entry undone" });
  }

  // ------------------------------------------------------------ barcode
  function onBarcode(code: string) {
    setScanOpen(false);
    const matches = allLines.filter((l) => l.barcodes.some((b) => b.barcode === code));
    if (!matches.length) { setUnknownCode(code); return; }
    const preferred = matches.find((m) => m.storage_location_id === current?.storage_location_id) ?? matches[0];
    jumpTo(preferred);
    const b = preferred.barcodes.find((x) => x.barcode === code);
    toast({ tone: "info", text: `${preferred.name}${matches.length > 1 ? ` (${matches.length} locations — showing ${storageName.get(preferred.storage_location_id ?? "") ?? "unassigned"})` : ""}` });
    setTimeout(() => (document.querySelector(`[data-unit="${b?.unit_id ?? preferred.units[0]?.unit_id}"]`) as HTMLInputElement | null)?.focus(), 60);
  }

  async function mapBarcode(productId: string) {
    const code = unknownCode; if (!code) return;
    const { data: prod } = await supabase.from("products").select("organization_id").eq("id", productId).single();
    const { error } = await supabase.from("product_barcodes").insert({ organization_id: prod?.organization_id, product_id: productId, barcode: code });
    if (error) { toast({ tone: "error", text: error.message }); return; }
    toast({ tone: "success", text: "Barcode mapped" });
    setUnknownCode(null);
    await refreshFromServer();
    const l = allLines.find((x) => x.product_id === productId);
    if (l) jumpTo(l);
  }

  // ------------------------------------------------------------ submit
  async function submit() {
    if (current) await commit(current);
    setSubmitting(true);
    try {
      await flush();
      const pending = (await idb.byIndex(STORES.queue, "session_id", sessionId)).length;
      if (pending) { toast({ tone: "info", text: `${pending} entries are still saved only on this device. Submit again when you are back online.` }); return; }
      if (status === "in_progress" || status === "not_started") {
        const { error } = await supabase.rpc("submit_count_session", { p_session: sessionId });
        if (error) { toast({ tone: "error", text: error.message }); return; }
      }
      toast({ tone: "success", text: "Count saved and sent for review" });
      router.push(canReview ? `/counts/${sessionId}/review` : "/counts");
    } finally { setSubmitting(false); }
  }

  // ------------------------------------------------------------ render
  if (!sheet) {
    return (
      <div className="py-16 text-center text-sm text-muted">
        {loadError ? <><p className="font-medium text-danger">{loadError}</p><Link className="mt-3 inline-block text-brand" href="/counts">Back to counts</Link></> : "Loading count sheet…"}
      </div>
    );
  }

  const areas = [
    ...sheet.storages,
    ...(allLines.some((l) => !l.storage_location_id) ? [{ id: "none", name: "Unassigned" }] : []),
  ];

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href="/counts" className="text-xs text-muted">← Counts</Link>
          <h1 className="truncate text-lg font-semibold">{sheet.session.name}</h1>
          <div className="text-xs text-muted">{sheet.session.count_number} · {sheet.session.location_name} · {status.replace(/_/g, " ")}</div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="lg:hidden"><SyncIndicator compact /></span>
          {source === "device" ? <span className="inline-flex items-center gap-1 text-[11px] text-warning"><CloudOff className="h-3 w-3" /> Saved to device</span> : null}
        </div>
      </div>

      {locked ? <div className="mb-3 rounded-md bg-surface-2 px-3 py-2 text-sm">This count is <b>{status}</b> and can no longer be edited.</div> : null}
      {reviewOnly && !canReview ? <div className="mb-3 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">Submitted for review. Only items marked <b>Recount</b> can be changed ({recountCount}).</div> : null}
      {sync.state === "error" && sync.lastError ? <div className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">Sync error: {sync.lastError}. Your entries are kept on this device.</div> : null}

      {/* progress */}
      <div className="mb-3">
        <div className="flex items-center justify-between text-sm">
          <span className="font-semibold tabular-nums" data-testid="count-progress">{counted} / {allLines.length}</span>
          <span className="text-xs text-muted">{allLines.length - counted} left{recountCount ? ` · ${recountCount} recount` : ""}</span>
        </div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2"><div className="h-full bg-brand transition-all" style={{ width: `${allLines.length ? (counted / allLines.length) * 100 : 0}%` }} /></div>
      </div>

      {/* area chips + filters */}
      <div className="-mx-3 mb-3 flex gap-1.5 overflow-x-auto px-3 pb-1">
        {[{ id: "all", name: "All areas" }, ...areas].map((a) => (
          <button key={a.id} type="button" onClick={() => { void (current && commit(current)); setArea(a.id); setIdx(0); }}
            className={cx("whitespace-nowrap rounded-full border px-3 py-1.5 text-sm", area === a.id ? "border-brand bg-brand text-white" : "border-border bg-surface")}>
            {a.name}
          </button>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border border-border bg-surface p-0.5 text-sm">
          {(["all", "uncounted", "recount"] as const).map((f) => (
            <button key={f} type="button" onClick={() => { setFilter(f); setIdx(0); }} className={cx("rounded px-2.5 py-1", filter === f ? "bg-surface-2 font-medium" : "text-muted")}>
              {f === "all" ? "All" : f === "uncounted" ? "Not counted" : "Recount / conflicts"}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant={voice.listening ? "danger" : "secondary"} onClick={toggleVoice} aria-pressed={voice.listening} disabled={locked}>
            {voice.listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}<span className="hidden sm:inline">{voice.listening ? "Stop" : "Voice"}</span>
          </Button>
          <Button size="sm" onClick={() => setScanOpen(true)} disabled={locked}><ScanLine className="h-4 w-4" /><span className="hidden sm:inline">Scan</span></Button>
          <Button size="sm" onClick={() => { void (current && commit(current)); setView(view === "focus" ? "list" : "focus"); }} aria-label="Toggle view">
            {view === "focus" ? <List className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}<span className="hidden sm:inline">{view === "focus" ? "List" : "One item"}</span>
          </Button>
        </div>
      </div>

      <VoicePanel voice={voice} lines={voiceLines} disabled={locked}
        onText={(t) => handleTranscript(t, 0.95)} onConfirm={(r, alt) => void applyVoice(r, alt)} onDiscard={() => setVoice((v) => ({ ...v, pending: undefined }))} onUndo={undoVoice} />

      {lines.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong p-8 text-center text-sm text-muted">Nothing to show with this filter.</div>
      ) : view === "focus" && current ? (
        <FocusCard
          key={current.item_id}
          line={current} position={Math.min(idx, lines.length - 1) + 1} of={lines.length}
          storage={current.storage_location_id ? storageName.get(current.storage_location_id) ?? "" : "Unassigned"}
          entry={entries[keyOf(sessionId, current)]} draft={draftFor(current)} total={totalOf(current, draftFor(current))}
          editable={editable(current)} firstInput={firstInput}
          onChange={(u, v) => setDraft(current, u, v)} onPrev={() => go(-1)} onNext={() => go(1)}
          onClear={() => { const d: Draft = {}; current.units.forEach((u) => (d[u.unit_id] = "")); void commit(current, { draft: d }); }}
        />
      ) : (
        <ListView lines={lines} sessionId={sessionId} entries={entries} storageName={storageName}
          draftFor={draftFor} totalOf={totalOf} editable={editable} onChange={setDraft} onCommit={(l) => void commit(l)} onOpen={(l) => jumpTo(l)} />
      )}

      <div className="sticky bottom-16 z-10 mt-4 flex gap-2 rounded-lg border border-border bg-surface/95 p-2 backdrop-blur lg:bottom-2">
        <Button className="flex-1" onClick={async () => { if (current) await commit(current); await flush(); toast({ tone: "success", text: sync.pending ? "Saved to this device" : "Saved" }); }} disabled={locked}>Save</Button>
        {!locked ? (
          <Button className="flex-1" variant="primary" onClick={submit} disabled={submitting}>
            {submitting ? "Saving…" : status === "awaiting_review" ? (canReview ? "Save & review" : "Save recount") : "Save & review"}
          </Button>
        ) : <Link className="flex-1 text-center text-sm leading-10 text-brand" href={`/counts/${sessionId}/review`}>Open review</Link>}
      </div>

      {scanOpen ? <BarcodeScanner onDetected={onBarcode} onClose={() => setScanOpen(false)} /> : null}
      {unknownCode ? (
        <UnknownBarcode code={unknownCode} canMap={canMapBarcode} lines={allLines} onMap={mapBarcode} onClose={() => setUnknownCode(null)} />
      ) : null}
    </div>
  );
}

type SpeechRec = {
  lang: string; continuous: boolean; interimResults: boolean; start: () => void; stop: () => void;
  onresult: (ev: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string; confidence: number } }> }) => void;
  onend: () => void; onerror: (ev: { error: string }) => void;
};

// ------------------------------------------------------------------------------------------------
function FocusCard({ line, position, of, storage, entry, draft, total, editable, onChange, onPrev, onNext, onClear, firstInput }: {
  line: Line; position: number; of: number; storage: string; entry: LocalEntry | undefined; draft: Draft; total: { total: Decimal | null; invalid: boolean };
  editable: boolean; onChange: (unitId: string, v: string) => void; onPrev: () => void; onNext: () => void; onClear: () => void;
  firstInput: React.RefObject<HTMLInputElement | null>;
}) {
  const base = line.units.find((u) => u.unit_id === line.inventory_unit_id);
  const units = [...line.units].sort((a, b) => Number(b.factor) - Number(a.factor));
  const bump = (u: Unit, d: number) => {
    const cur = evaluate(draft[u.unit_id] ?? "") ?? 0;
    onChange(u.unit_id, String(Math.max(0, Math.round((cur + d) * 10000) / 10000)));
  };
  return (
    <div className={cx("rounded-xl border bg-surface p-4 shadow-sm", entry?.recount_requested ? "border-warning" : entry?.has_conflict ? "border-danger" : "border-border")} data-testid="focus-card">
      <div className="flex items-center justify-between text-xs text-muted">
        <span className="font-semibold uppercase tracking-wide">{storage}{line.shelf ? ` · ${line.shelf}` : ""}</span>
        <span className="tabular-nums">{position} / {of}</span>
      </div>
      <h2 className="mt-1 text-2xl font-semibold leading-tight" data-testid="current-item">{line.name}</h2>
      <div className="text-xs text-muted">#{line.product_number}{line.category ? ` · ${line.category}` : ""} · Inventory unit {base?.code}</div>
      <EntryStatus entry={entry} />
      <form onSubmit={(e) => { e.preventDefault(); onNext(); }} className="mt-4 space-y-3">
        {units.map((u, i) => (
          <div key={u.unit_id} className="flex items-center gap-2">
            <label htmlFor={`q-${u.unit_id}`} className="w-20 text-sm font-semibold">{u.code}
              {Number(u.factor) !== 1 ? <span className="block text-[11px] font-normal text-muted">= {Number(u.factor)} {base?.code}</span> : null}
            </label>
            <button type="button" aria-label={`Minus one ${u.code}`} disabled={!editable} onClick={() => bump(u, -1)} className="grid h-12 w-12 place-items-center rounded-lg border border-border-strong bg-surface-2 disabled:opacity-40"><Minus className="h-5 w-5" /></button>
            <input
              id={`q-${u.unit_id}`} data-unit={u.unit_id} ref={i === 0 ? firstInput : undefined}
              inputMode="decimal" autoComplete="off" enterKeyHint="next" disabled={!editable}
              value={draft[u.unit_id] ?? ""} onChange={(e) => onChange(u.unit_id, e.target.value)} placeholder="0"
              className={cx(inputBase, "h-12 min-w-0 flex-1 text-center text-xl font-semibold tabular-nums", draft[u.unit_id] && evaluate(draft[u.unit_id]) === null && "border-danger")}
            />
            <button type="button" aria-label={`Plus one ${u.code}`} disabled={!editable} onClick={() => bump(u, 1)} className="grid h-12 w-12 place-items-center rounded-lg border border-border-strong bg-surface-2 disabled:opacity-40"><Plus className="h-5 w-5" /></button>
          </div>
        ))}
        <div className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
          <span className="text-sm text-muted">Total</span>
          <span className="text-xl font-bold tabular-nums" data-testid="line-total">{total.total ? `${total.total.toNumber().toLocaleString("en-US", { maximumFractionDigits: 4 })} ${base?.code}` : "—"}</span>
        </div>
        {total.invalid ? <p className="text-xs text-danger">One value is not a number. You can type math like 3*12+4.</p> : <p className="text-[11px] text-muted">Tip: type math like 3*12+4. Press Enter for the next item.</p>}
        <div className="grid grid-cols-[1fr_auto_1fr] gap-2 pt-1">
          <Button size="lg" className="px-2" onClick={onPrev} disabled={position <= 1}><ChevronLeft className="h-5 w-5" /> Previous</Button>
          <Button size="lg" className="px-2" variant="ghost" onClick={onClear} disabled={!editable || !entry}>Clear</Button>
          <Button size="lg" className="px-2" variant="primary" type="submit">{position >= of ? "Save" : "Next"} <ChevronRight className="h-5 w-5" /></Button>
        </div>
      </form>
    </div>
  );
}

function EntryStatus({ entry }: { entry: LocalEntry | undefined }) {
  if (!entry || entry.cleared) return <div className="mt-2"><Badge>Not counted</Badge></div>;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
      {entry.error ? <Badge tone="danger"><AlertTriangle className="h-3 w-3" /> Not saved: {entry.error}</Badge>
        : entry.pending ? <Badge tone="warning"><Clock className="h-3 w-3" /> Saved to device</Badge>
        : <Badge tone="success"><CheckCircle2 className="h-3 w-3" /> Synced</Badge>}
      {entry.has_conflict ? <Badge tone="danger">Conflict — a manager will pick the right count</Badge> : null}
      {entry.recount_requested ? <Badge tone="warning">Recount requested</Badge> : null}
      {entry.counted_by_name ? <span className="text-muted">Counted by {entry.counted_by_name}</span> : null}
      {entry.method === "voice" && entry.voice_transcript ? <span className="text-muted">· 🎤 “{entry.voice_transcript}”</span> : null}
    </div>
  );
}

function ListView({ lines, sessionId, entries, storageName, draftFor, totalOf, editable, onChange, onCommit, onOpen }: {
  lines: Line[]; sessionId: string; entries: Record<string, LocalEntry>; storageName: Map<string, string>;
  draftFor: (l: Line) => Draft; totalOf: (l: Line, d: Draft) => { total: Decimal | null; invalid: boolean }; editable: (l: Line) => boolean;
  onChange: (l: Line, u: string, v: string) => void; onCommit: (l: Line) => void; onOpen: (l: Line) => void;
}) {
  let lastGroup = "";
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      {lines.map((l) => {
        const group = `${l.storage_location_id ? storageName.get(l.storage_location_id) : "Unassigned"}${l.shelf ? ` · ${l.shelf}` : ""}`;
        const header = group !== lastGroup ? group : null;
        lastGroup = group;
        const e = entries[keyOf(sessionId, l)];
        const d = draftFor(l);
        const t = totalOf(l, d);
        const base = l.units.find((u) => u.unit_id === l.inventory_unit_id);
        return (
          <div key={l.item_id}>
            {header ? <div className="bg-surface-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{header}</div> : null}
            <div className={cx("flex flex-wrap items-center gap-2 border-b border-border px-3 py-2", e?.recount_requested && "bg-warning-soft", e?.has_conflict && "bg-danger-soft")}>
              <button type="button" onClick={() => onOpen(l)} className="min-w-0 flex-1 text-left">
                <div className="truncate text-sm font-medium">{l.name}</div>
                <div className="text-[11px] text-muted">
                  {e?.pending ? "Saved to device · " : ""}{e?.counted_by_name && !e.cleared ? `${e.counted_by_name}` : "Not counted"}{e?.recount_requested ? " · RECOUNT" : ""}{e?.has_conflict ? " · CONFLICT" : ""}
                </div>
              </button>
              <div className="flex items-center gap-1">
                {[...l.units].sort((a, b) => Number(b.factor) - Number(a.factor)).map((u) => (
                  <label key={u.unit_id} className="flex items-center gap-1 text-[11px] text-muted">
                    <input inputMode="decimal" aria-label={`${l.name} ${u.code}`} disabled={!editable(l)} value={d[u.unit_id] ?? ""} placeholder="0"
                      onChange={(ev) => onChange(l, u.unit_id, ev.target.value)} onBlur={() => onCommit(l)}
                      onKeyDown={(ev) => { if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); }}
                      className={cx(inputBase, "h-9 w-16 px-2 text-right text-sm tabular-nums")} />
                    {u.code}
                  </label>
                ))}
              </div>
              <div className="w-24 text-right text-sm font-semibold tabular-nums">{t.total ? `${t.total.toNumber().toLocaleString("en-US", { maximumFractionDigits: 2 })} ${base?.code}` : "—"}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function VoicePanel({ voice, lines, disabled, onText, onConfirm, onDiscard, onUndo }: {
  voice: { listening: boolean; last?: VoiceResult; pending?: VoiceResult; undo?: unknown }; lines: VoiceLine[]; disabled: boolean;
  onText: (t: string) => void; onConfirm: (r: VoiceResult, alt?: VoiceLine) => void; onDiscard: () => void; onUndo: () => void;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const p = voice.pending;
  return (
    <div className="mb-3 space-y-2">
      {voice.listening ? <div className="rounded-md bg-info-soft px-3 py-2 text-sm text-info">Listening… say e.g. “Chicken breast, one case and eight and a half pounds”.</div> : null}
      {p ? (
        <div className="rounded-lg border border-warning bg-warning-soft p-3 text-sm" role="alert" data-testid="voice-confirm">
          <div className="text-xs text-muted">Heard</div>
          <div className="font-medium">“{p.transcript}”</div>
          <div className="mt-2">
            {p.line ? <>→ <b>{p.line.name}</b>: {p.breakdown.map((b) => `${b.qty} ${b.code}`).join(" + ") || "no quantity"}</> : "No matching product"}
            <span className="ml-2 text-xs text-muted">confidence {Math.round(p.confidence * 100)}%</span>
          </div>
          {p.issues.length ? <ul className="mt-1 list-disc pl-5 text-xs text-warning">{p.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}
          <div className="mt-2 flex flex-wrap gap-2">
            {p.line && p.breakdown.length ? <Button size="sm" variant="primary" onClick={() => onConfirm(p)}>Confirm {p.line.name}</Button> : null}
            {p.alternatives.map((a) => <Button key={a.key} size="sm" onClick={() => onConfirm({ ...p, line: a, breakdown: p.breakdown }, a)}>Use {a.name}</Button>)}
            <Button size="sm" variant="ghost" onClick={onDiscard}>Discard</Button>
          </div>
        </div>
      ) : null}
      {voice.last && !p ? (
        <div className="flex items-center justify-between rounded-md bg-success-soft px-3 py-2 text-sm text-success">
          <span>🎤 “{voice.last.transcript}” → {voice.last.line?.name}: {voice.last.breakdown.map((b) => `${b.qty} ${b.code}`).join(" + ")}</span>
          {voice.undo ? <Button size="sm" variant="ghost" onClick={onUndo}>Undo</Button> : null}
        </div>
      ) : null}
      <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} className="text-sm">
        <summary className="cursor-pointer text-xs text-muted">Type a voice phrase</summary>
        <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onText(text); setText(""); } }}>
          <input value={text} onChange={(e) => setText(e.target.value)} disabled={disabled} placeholder="avocado two cases six each" aria-label="Voice phrase"
            className={cx(inputBase, "h-9 flex-1")} list="voice-products" />
          <datalist id="voice-products">{lines.slice(0, 200).map((l) => <option key={l.key} value={l.name} />)}</datalist>
          <Button size="sm" type="submit" disabled={disabled}>Interpret</Button>
        </form>
      </details>
    </div>
  );
}

function UnknownBarcode({ code, canMap, lines, onMap, onClose }: { code: string; canMap: boolean; lines: Line[]; onMap: (productId: string) => void; onClose: () => void }) {
  const [pid, setPid] = useState("");
  const products = Array.from(new Map(lines.map((l) => [l.product_id, l.name])).entries()).sort((a, b) => a[1].localeCompare(b[1]));
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal>
      <div className="w-full max-w-sm rounded-lg bg-surface p-4">
        <h3 className="font-semibold">Barcode not recognized</h3>
        <p className="mt-1 font-mono text-sm">{code}</p>
        {canMap ? (
          <div className="mt-3 space-y-2">
            <label className="block text-xs text-muted">Map this barcode to a product</label>
            <select value={pid} onChange={(e) => setPid(e.target.value)} className={cx(inputBase, "w-full")}>
              <option value="">Choose product…</option>
              {products.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            <Button variant="primary" className="w-full" disabled={!pid} onClick={() => onMap(pid)}>Map barcode</Button>
          </div>
        ) : <p className="mt-2 text-sm text-muted">Ask a manager to map it to a product.</p>}
        <Button className="mt-2 w-full" variant="ghost" onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}
