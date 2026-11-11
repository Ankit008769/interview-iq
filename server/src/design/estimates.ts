import type { DesignPrompt } from './prompts.js';

// Capacity estimates (roadmap C3). The reference values follow from the prompt's scale card with the usual
// back-of-the-envelope formulas; the candidate's numbers are judged by how many times off they are, since
// interviewers look for the right order of magnitude, not exact arithmetic.
export const ESTIMATE_IDS = ['writeQps', 'peakReadQps', 'storagePerYear'] as const;
export type EstimateId = typeof ESTIMATE_IDS[number];
export const STORAGE_UNITS = { KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15 } as const;
export type StorageUnit = keyof typeof STORAGE_UNITS;
export type EstimateInput = { writeQps?: number | null; peakReadQps?: number | null; storagePerYear?: { value: number; unit: StorageUnit } | null };
export type EstimateResult = { id: EstimateId; label: string; given: number | null; reference: number; unit: string; ratio: number | null;
  verdict: 'close' | 'order_of_magnitude' | 'off' | 'missing'; formula: string };

const DAY = 86_400;
const fmt = (x: number, digits = 2) => x.toLocaleString('en-US', { maximumFractionDigits: digits });
const n = (x: number) => (x >= 1e9 ? `${fmt(x / 1e9, 1)} billion` : x >= 1e6 ? `${fmt(x / 1e6, 1)} million` : fmt(x));
export function bytesLabel(bytes: number) {
  const unit = (['PB', 'TB', 'GB', 'MB', 'KB'] as StorageUnit[]).find(u => bytes >= STORAGE_UNITS[u]) ?? 'KB';
  return `${fmt(bytes / STORAGE_UNITS[unit], 1)} ${unit}`;
}

export function scaleCard(p: DesignPrompt) {
  const s = p.scale;
  return `${n(s.actors)} ${s.actorLabel}. Per day, each accounts for about ${n(s.writesPer)} ${s.writeLabel} and ${n(s.readsPer)} ${s.readLabel}. Each of the ${s.writeLabel} stores about ${bytesLabel(s.bytesPerWrite)}. Peak traffic is ${s.peakFactor} times the daily average.`;
}

export function referenceEstimates(p: DesignPrompt): { id: EstimateId; label: string; unit: string; value: number; formula: string }[] {
  const s = p.scale;
  const writes = s.actors * s.writesPer, reads = s.actors * s.readsPer;
  return [
    { id: 'writeQps', label: `Average ${s.writeLabel} per second`, unit: 'per second', value: writes / DAY,
      formula: `${n(s.actors)} × ${n(s.writesPer)} ÷ 86,400 s ≈ ${n(Math.round(writes / DAY))} per second` },
    { id: 'peakReadQps', label: `Peak ${s.readLabel} per second`, unit: 'per second', value: (reads / DAY) * s.peakFactor,
      formula: `${n(s.actors)} × ${n(s.readsPer)} ÷ 86,400 s × ${s.peakFactor} (peak) ≈ ${n(Math.round(reads / DAY * s.peakFactor))} per second` },
    { id: 'storagePerYear', label: 'New storage per year', unit: 'bytes', value: writes * s.bytesPerWrite * 365,
      formula: `${n(writes)} ${s.writeLabel} a day × ${bytesLabel(s.bytesPerWrite)} × 365 ≈ ${bytesLabel(writes * s.bytesPerWrite * 365)} (before replication)` },
  ];
}

export function checkEstimates(p: DesignPrompt, input: EstimateInput): EstimateResult[] {
  return referenceEstimates(p).map(ref => {
    const raw = ref.id === 'storagePerYear' ? (input.storagePerYear ? input.storagePerYear.value * STORAGE_UNITS[input.storagePerYear.unit] : null) : input[ref.id] ?? null;
    const given = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
    const ratio = given === null ? null : given / ref.value;
    const off = ratio === null ? Infinity : Math.max(ratio, 1 / ratio);
    const verdict = given === null ? 'missing' : off <= 2 ? 'close' : off <= 10 ? 'order_of_magnitude' : 'off';
    return { id: ref.id, label: ref.label, given, reference: ref.value, unit: ref.unit, ratio, verdict, formula: ref.formula };
  });
}
