// Ranking. Candidates arrive already filtered by recommendation_candidates() (status, visibility,
// blocks, capacity, joined, dismissed, time window); here the query's own hard constraints are
// applied, then five scores in 0..1 are combined:
//   query 0.30   share of search words and categories the event matches
//   semantic 0.25 embedding similarity to the search
//   interest 0.20 the user's stated interests and the categories they join, attend, click or dismiss
//   context 0.15 how soon it starts, how close it is, whether places are left
//   quality 0.10 how complete and trustworthy the listing is
// A score that has nothing to go on (no search, no embedding, no history) is left out and the
// remaining weights are rescaled, instead of counting as a neutral 0.5.
import { haystack, matches, type Haystack } from './text'
import type { Breakdown, Candidate, ParsedQuery, Ranked, Signal } from './types'
import type { PersonalWeights, PreferenceFeatures } from './types'
import { adaptiveScore } from './adaptive'
import { conflictsWithSport, expansionScore, matchesExclusion, type SearchExpansion } from './expansion'

export const WEIGHTS = { query: 0.3, semantic: 0.25, interest: 0.2, context: 0.15, quality: 0.1 } as const

const SIGNAL_WEIGHT: Record<string, number> = { attend: 1, join: 0.6, click: 0.15, cancel_join: -0.3, dismiss: -0.5 }
const HALF_LIFE_DAYS = 60

// Cosine similarity of typical text-embedding models sits between ~0.1 (unrelated) and ~0.6 (close).
const SIM_FLOOR = 0.15
const SIM_CEIL = 0.6

/** Per-category weight in -1..1 from the user's history, newer actions counting more. */
export function categoryWeights(signals: Signal[], now: Date): Map<string, number> {
  const raw = new Map<string, number>()
  for (const s of signals) {
    const w = SIGNAL_WEIGHT[s.signal]
    if (!w) continue
    const ageDays = Math.max(0, (now.getTime() - new Date(s.at).getTime()) / 86_400_000)
    raw.set(s.category, (raw.get(s.category) ?? 0) + w * 0.5 ** (ageDays / HALF_LIFE_DAYS))
  }
  const max = Math.max(1, ...[...raw.values()].map(Math.abs))
  return new Map([...raw].map(([k, v]) => [k, v / max]))
}

export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (v: number) => (v * Math.PI) / 180
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(h))
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

export interface RankInput {
  candidates: Candidate[]
  query: ParsedQuery
  /** Free-text interests from the profile. */
  interests: string[]
  signals: Signal[]
  origin: { lat: number; lng: number } | null
  /** Similarity for events embedded during this request (cached ones come from the database). */
  freshSimilarity?: Map<string, number>
  hasQueryEmbedding: boolean
  now: Date
  limit: number
  personalWeights?: PersonalWeights
  expansion?: SearchExpansion
}

function textOf(c: Candidate): Haystack {
  return haystack(`${c.title} ${c.category} ${c.description} ${c.location_text}`)
}

function hasLocation(c: Candidate): c is Candidate & { location_lat: number; location_lng: number } {
  return c.location_lat != null && c.location_lng != null
}

/** Applies the query's explicit constraints. Everything else only affects order. */
export function passesQuery(c: Candidate, h: Haystack, q: ParsedQuery, origin: RankInput['origin']): boolean {
  if (q.exclude.some((x) => matchesExclusion(h, x))) return false
  if (q.maxDistanceKm != null && origin) {
    if (!hasLocation(c) || distanceKm(origin, { lat: c.location_lat, lng: c.location_lng }) > q.maxDistanceKm) return false
  }
  return true
}

function queryScore(c: Candidate, h: Haystack, q: ParsedQuery): { score: number | null; hits: string[] } {
  const parts: number[] = []
  const hits = q.keywords.filter((k) => matches(h, k))
  if (q.keywords.length) {
    // Title hits count a little extra: "篮球" in the title beats a passing mention.
    const title = haystack(c.title)
    const titleHits = hits.filter((k) => matches(title, k)).length
    parts.push(clamp01((hits.length + 0.5 * titleHits) / q.keywords.length))
  }
  if (q.categories.length) parts.push(q.categories.includes(c.category) ? 1 : 0)
  return { score: parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null, hits }
}

function interestScore(c: Candidate, h: Haystack, interests: string[], cats: Map<string, number>) {
  const stated = interests.filter((i) => i === c.category || matches(h, i))
  const learned = cats.get(c.category)
  // Without any stated interest or history there is nothing to personalise on.
  if (!interests.length && !cats.size) return { score: null, stated, learned }
  let s = stated.length ? 0.7 + 0.1 * Math.min(3, stated.length - 1) : 0.3
  if (learned !== undefined) s += 0.3 * learned
  return { score: clamp01(s), stated, learned }
}

function contextScore(c: Candidate, origin: RankInput['origin'], now: Date) {
  const hours = (new Date(c.starts_at).getTime() - now.getTime()) / 3_600_000
  // Already started (still on) is fine but less useful than something coming up.
  const time = hours < 0 ? 0.6 : hours <= 48 ? 1 : hours <= 168 ? 0.85 : hours <= 720 ? 0.6 : 0.4
  const left = c.capacity == null ? null : c.capacity - c.going
  const seats = left == null || left > 2 ? 1 : 0.8
  // Without a starting point distance is left out rather than guessed.
  if (!origin) return { score: clamp01(0.75 * time + 0.25 * seats), km: null, left, time, seats, distance: null }
  const km = hasLocation(c) ? distanceKm(origin, { lat: c.location_lat, lng: c.location_lng }) : null
  const place = km == null ? 0.3 : clamp01(1 - km / 10)
  return { score: clamp01(0.45 * time + 0.4 * place + 0.15 * seats), km, left, time, seats, distance: km == null ? null : place }
}

function qualityScore(c: Candidate): number {
  let s = 0.2
  if (c.description.trim().length >= 40) s += 0.3
  if (hasLocation(c) || c.location_text.trim()) s += 0.2
  if (c.ends_at) s += 0.1
  if (c.org_verified) s += 0.2
  return clamp01(s)
}

function semanticScore(c: Candidate, input: RankInput): number | null {
  if (!input.hasQueryEmbedding) return null
  const sim = input.freshSimilarity?.get(c.id) ?? c.similarity
  return sim == null ? null : clamp01((sim - SIM_FLOOR) / (SIM_CEIL - SIM_FLOOR))
}

export function combine(b: Breakdown): number {
  let total = 0
  let weight = 0
  for (const k of Object.keys(WEIGHTS) as (keyof Breakdown)[]) {
    const v = b[k]
    if (v == null) continue
    total += WEIGHTS[k] * v
    weight += WEIGHTS[k]
  }
  return weight ? total / weight : 0
}

function reasons(c: Candidate, hits: string[], matchedCategory: boolean, stated: string[], learned: number | undefined,
                 semantic: number | null, km: number | null, left: number | null, q: ParsedQuery): string[] {
  const out: string[] = []
  if (hits.length) out.push(`符合你的搜索：${hits.slice(0, 3).join('、')}`)
  else if (matchedCategory) out.push(`属于你要找的「${c.category}」`)
  if (semantic != null && semantic >= 0.6 && !hits.length) out.push('内容和你的描述很接近')
  if (stated.length) out.push(`你的兴趣：${stated.slice(0, 2).join('、')}`)
  else if (learned != null && learned >= 0.3) out.push(`你常参加「${c.category}」类活动`)
  if (q.timeLabel) out.push(`在${q.timeLabel}`)
  if (km != null) out.push(km < 1 ? `离你约 ${Math.round(km * 1000)} 米` : `离你约 ${km.toFixed(1)} 公里`)
  if (left != null && left <= 5) out.push(`还剩 ${left} 个名额`)
  if (c.org_verified) out.push('认证组织主办')
  return out.length ? out : ['即将开始的活动']
}

/** Deterministic for the same inputs: ties break by start time, then id. */
export function rank(input: RankInput): { eligible: number; ranked: Ranked[] } {
  const cats = categoryWeights(input.signals, input.now)
  const scored: Ranked[] = []
  for (const c of input.candidates) {
    const h = textOf(c)
    if (input.expansion && conflictsWithSport(c.title, input.expansion)) continue
    const effectiveQuery = input.expansion ? { ...input.query, exclude: input.expansion.excluded } : input.query
    if (!passesQuery(c, h, effectiveQuery, input.origin)) continue
    const q = queryScore(c, h, input.query)
    const related = input.expansion ? expansionScore(`${c.title} ${c.category} ${c.description}`, input.expansion) : null
    if (related != null) q.score = Math.max(q.score ?? 0, related)
    const sem = semanticScore(c, input)
    const it = interestScore(c, h, input.interests, cats)
    const ctx = contextScore(c, input.origin, input.now)
    const breakdown: Breakdown = { query: q.score, semantic: sem, interest: it.score, context: ctx.score, quality: qualityScore(c) }
    const features: PreferenceFeatures = { query: q.score, semantic: sem, interest: it.score,
      time: ctx.time, distance: ctx.distance, seats: ctx.seats, quality: breakdown.quality }
    scored.push({
      candidate: c,
      score: input.personalWeights?.status === 'personalised'
        ? adaptiveScore(features, input.personalWeights, input.origin !== null) : combine(breakdown),
      breakdown,
      features,
      reasons: reasons(c, q.hits, input.query.categories.includes(c.category), it.stated, it.learned, sem, ctx.km, ctx.left, input.query),
    })
  }
  scored.sort((a, b) => b.score - a.score || a.candidate.starts_at.localeCompare(b.candidate.starts_at)
    || a.candidate.id.localeCompare(b.candidate.id))
  return { eligible: scored.length, ranked: diversify(scored, input.limit) }
}

/** Greedy re-rank so one category does not fill the whole list; reported scores stay as computed. */
export function diversify(sorted: Ranked[], limit: number, penalty = 0.06): Ranked[] {
  const pool = [...sorted]
  const out: Ranked[] = []
  const seen = new Map<string, number>()
  while (out.length < limit && pool.length) {
    let best = 0
    let bestValue = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const v = pool[i]!.score - penalty * (seen.get(pool[i]!.candidate.category) ?? 0)
      if (v > bestValue) { bestValue = v; best = i }
    }
    const [pick] = pool.splice(best, 1)
    out.push(pick!)
    seen.set(pick!.candidate.category, (seen.get(pick!.candidate.category) ?? 0) + 1)
  }
  return out
}
