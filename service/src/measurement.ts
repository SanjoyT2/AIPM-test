/**
 * Measurement engine (docs 02, ADR-003) — turns evidence events into a mastery
 * profile and a composite score. PURE and DETERMINISTIC: no LLM, no clock reads
 * beyond the `asOf` passed in, no randomness. Same events + same config version
 * => same score, forever. This is what makes the credential defensible.
 *
 * Everything it does is driven by the editable config:
 *   - competency-framework.yaml : competencies, thresholds, per-level weights
 *   - composite-formula.yaml    : source weights, recency, integrity curve, ranks
 */
import type { EvidenceEvent } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CompetencyMastery {
  competency_id: string;
  name: string;
  estimate: number;          // 0-100
  at_threshold: boolean;
  threshold: number;
  evidence_count: number;
}

export interface IntegrityFinding {
  competency_id: string;
  delta: number;             // async_avg - sync_avg (positive = suspicious)
  async_score: number;
  sync_score: number;
  review: boolean;           // at/above the review-queue threshold
}

export interface CompositeBreakdown {
  base: number;
  integrity_multiplier: number;
  final: number;
  rank_band: string;
  rank_band_id: string;
  formula_version: string;
  framework_version: string;
  sources: { source: string; weight: number; score: number; evidence_count: number }[];
}

export interface LearnerMeasurement {
  learner_id: string;
  mastery: CompetencyMastery[];
  composite: CompositeBreakdown;
  integrity: IntegrityFinding[];
  evidence_count: number;
}

// activity_type -> composite source bucket. engagement has no evidence type; it
// is supplied separately (streak-derived) via `engagementScore`.
const SOURCE_OF: Record<EvidenceEvent["activity_type"], string> = {
  gate_viva: "gate",
  quiz: "quiz",
  task: "task",
  peer_review: "peer_review",
  live_session: "live_session",
  diagnostic: "quiz", // diagnostics are low-stakes knowledge checks; never counted summatively (filtered below)
};

export class MeasurementEngine {
  private competencies: { id: string; name: string; threshold: number; weight: number; level: string }[];
  private compositeCfg: any;

  constructor(private frameworks: any) {
    this.compositeCfg = frameworks.compositeFormula;
    this.competencies = [];
    for (const level of frameworks.competencyFramework.levels ?? []) {
      for (const c of level.competencies ?? []) {
        this.competencies.push({ id: c.id, name: c.name, threshold: c.mastery_threshold, weight: c.weight_in_level ?? 0, level: level.id });
      }
    }
    for (const c of frameworks.competencyFramework.cross_cutting ?? []) {
      this.competencies.push({ id: c.id, name: c.name, threshold: c.mastery_threshold, weight: 0, level: "XC" });
    }
  }

  /** Recency weight — exponential half-life decay from composite-formula.rollup. */
  private recencyWeight(ts: string, asOf: number): number {
    const half = this.compositeCfg.rollup?.recency_half_life_days ?? 21;
    if (half <= 0) return 1;
    const ageDays = Math.max(0, (asOf - new Date(ts).getTime()) / DAY_MS);
    return Math.pow(0.5, ageDays / half);
  }

  private norm(e: EvidenceEvent): number {
    return e.scale_max > 0 ? (e.score / e.scale_max) * 100 : 0;
  }

  compute(learnerId: string, events: EvidenceEvent[], opts: { asOf: number; engagementScore?: number; clearedIntegrity?: Set<string> } ): LearnerMeasurement {
    const mine = events.filter((e) => e.learner_id === learnerId);

    // ---- Mastery per competency: recency-weighted mean of its evidence ----
    const mastery: CompetencyMastery[] = this.competencies.map((c) => {
      const evs = mine.filter((e) => e.competency_id === c.id);
      const est = this.weightedMean(evs, opts.asOf);
      return {
        competency_id: c.id, name: c.name, threshold: c.threshold,
        estimate: round(est), at_threshold: est >= c.threshold, evidence_count: evs.length,
      };
    });

    // ---- Composite base: Σ weight × source_score ----
    const weights: Record<string, number> = this.compositeCfg.source_weights;
    const sources = Object.keys(weights).map((src) => {
      if (src === "engagement") {
        return { source: src, weight: weights[src], score: round(opts.engagementScore ?? 0), evidence_count: 0 };
      }
      const evs = mine.filter((e) => SOURCE_OF[e.activity_type] === src && e.tags?.includes("diagnostic") !== true);
      return { source: src, weight: weights[src], score: round(this.weightedMean(evs, opts.asOf)), evidence_count: evs.length };
    });
    const base = sources.reduce((a, s) => a + s.weight * s.score, 0);

    // ---- Integrity: async-vs-sync delta per competency ----
    const integrity = this.integrityFindings(mine, opts.asOf, opts.clearedIntegrity ?? new Set());
    const worst = integrity.filter((f) => !opts.clearedIntegrity?.has(f.competency_id)).reduce((m, f) => Math.max(m, f.delta), 0);
    const multiplier = this.integrityMultiplier(worst);

    const final = base * multiplier;
    const band = this.rankBand(final);

    return {
      learner_id: learnerId,
      mastery,
      integrity,
      evidence_count: mine.length,
      composite: {
        base: round(base), integrity_multiplier: multiplier, final: round(final),
        rank_band: band.name, rank_band_id: band.id,
        formula_version: this.compositeCfg.version,
        framework_version: this.frameworks.competencyFramework.version,
        sources,
      },
    };
  }

  private weightedMean(evs: EvidenceEvent[], asOf: number): number {
    if (!evs.length) return 0;
    let wsum = 0, vsum = 0;
    for (const e of evs) {
      const w = this.recencyWeight(e.timestamp, asOf);
      wsum += w; vsum += w * this.norm(e);
    }
    return wsum > 0 ? vsum / wsum : 0;
  }

  private integrityFindings(evs: EvidenceEvent[], asOf: number, cleared: Set<string>): IntegrityFinding[] {
    const byComp = new Map<string, EvidenceEvent[]>();
    for (const e of evs) {
      if (!byComp.has(e.competency_id)) byComp.set(e.competency_id, []);
      byComp.get(e.competency_id)!.push(e);
    }
    const threshold = this.compositeCfg.integrity?.review_queue_threshold_delta ?? 20;
    const findings: IntegrityFinding[] = [];
    for (const [comp, list] of byComp) {
      const asyncEvs = list.filter((e) => e.modality === "async");
      const syncEvs = list.filter((e) => e.modality === "sync");
      if (!asyncEvs.length || !syncEvs.length) continue; // need both sides to compare
      const a = this.weightedMean(asyncEvs, asOf);
      const s = this.weightedMean(syncEvs, asOf);
      const delta = a - s;
      if (delta <= 0) continue; // only positive (looks-good-async, weak-live) is suspicious
      findings.push({ competency_id: comp, delta: round(delta), async_score: round(a), sync_score: round(s), review: delta >= threshold && !cleared.has(comp) });
    }
    return findings.sort((x, y) => y.delta - x.delta);
  }

  private integrityMultiplier(worstDelta: number): number {
    const curve = this.compositeCfg.integrity?.curve ?? [{ max_delta: 999, multiplier: 1 }];
    for (const step of curve) if (worstDelta <= step.max_delta) return step.multiplier;
    return 1;
  }

  private rankBand(final: number): { id: string; name: string } {
    const bands = [...(this.compositeCfg.rank_bands ?? [])].sort((a, b) => b.min_final - a.min_final);
    for (const b of bands) if (final >= b.min_final) return { id: b.id, name: b.name };
    return { id: "NONE", name: "Unranked" };
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
