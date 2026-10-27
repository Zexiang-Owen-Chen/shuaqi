// Interpretable, bounded preference learning from within-request contrasts.
// An unselected result is only a WEAK reference, never an explicit dislike.
import { PREFERENCE_KEYS, type PersonalWeights, type PreferenceFeatures, type PreferenceKey, type WeightObservation } from './types'

export const MIN_REQUESTS = 8
export const MIN_EVIDENCE = 2
export const MAX_MULTIPLIER = 1.4
export const MIN_MULTIPLIER = 0.6
const DAY = 86_400_000
const HALF_LIFE_DAYS = 30
const MAX_AGE_DAYS = 90
const STRENGTH: Record<string, number> = { attend: 1, join: 0.8, click: 0.15, dismiss: -0.6, cancel_join: -0.4 }
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

export function defaultPersonalWeights(status: PersonalWeights['status'] = 'cold_start'): PersonalWeights {
  return { status, requestCount: 0, evidence: 0, multipliers: Object.fromEntries(PREFERENCE_KEYS.map(k => [k, 1])) as Record<PreferenceKey, number> }
}

function observation(value: unknown, now: number): WeightObservation | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  if (typeof r.request_id !== 'string' || !r.request_id || typeof r.event_id !== 'string' || !r.event_id) return null
  const shown = typeof r.shown_at === 'string' ? Date.parse(r.shown_at) : NaN
  if (!Number.isFinite(shown) || shown > now + 300_000 || shown < now - MAX_AGE_DAYS * DAY) return null
  if (!r.features || typeof r.features !== 'object') return null
  const raw = r.features as Record<string, unknown>
  const features = {} as PreferenceFeatures
  for (const key of [...PREFERENCE_KEYS, 'seats'] as const) {
    const n = raw[key]
    features[key] = typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1 ? n : null
  }
  const feedback = typeof r.feedback === 'string' && Object.hasOwn(STRENGTH, r.feedback) ? r.feedback as WeightObservation['feedback'] : null
  const at = typeof r.feedback_at === 'string' ? Date.parse(r.feedback_at) : NaN
  const validFeedback = feedback && Number.isFinite(at) && at >= shown && at <= now + 300_000 && at - shown <= 30 * DAY
  return {
    request_id: r.request_id, event_id: r.event_id, shown_at: r.shown_at as string,
    position: typeof r.position === 'number' ? r.position : 0, features,
    feedback: validFeedback ? feedback : null,
    feedback_at: validFeedback ? r.feedback_at as string : null,
  }
}

/** One outcome per request prevents rapid repeat clicks from dominating the model. */
export function learnPersonalWeights(raw: readonly unknown[], now: Date): PersonalWeights {
  const result = defaultPersonalWeights()
  if (!Number.isFinite(now.getTime())) return result
  const unique = new Map<string, WeightObservation>()
  for (const value of raw) {
    const row = observation(value, now.getTime())
    if (!row) continue
    const key = `${row.request_id}:${row.event_id}`
    const previous = unique.get(key)
    if (!previous || Math.abs(STRENGTH[row.feedback ?? ''] ?? 0) > Math.abs(STRENGTH[previous.feedback ?? ''] ?? 0)) unique.set(key, row)
  }
  const rows = [...unique.values()].sort((a, b) => b.shown_at.localeCompare(a.shown_at)).slice(0, 1000)
  const groups = new Map<string, WeightObservation[]>()
  for (const row of rows) groups.set(row.request_id, [...(groups.get(row.request_id) ?? []), row])
  const effects = Object.fromEntries(PREFERENCE_KEYS.map(k => [k, { sum: 0, weight: 0, count: 0, evidence: 0 }])) as Record<PreferenceKey, { sum: number; weight: number; count: number; evidence: number }>
  const seenActions = new Set<string>()
  for (const group of groups.values()) {
    const ordered = group.filter(r => r.feedback).sort((a, b) => Math.abs(STRENGTH[b.feedback!]!) - Math.abs(STRENGTH[a.feedback!]!))
    const target = ordered.find(r => !seenActions.has(`${r.event_id}:${r.feedback}:${r.feedback_at}`))
    if (!target) continue
    const actionKey = `${target.event_id}:${target.feedback}:${target.feedback_at}`
    const strength = STRENGTH[target.feedback!]!
    const age = Math.max(0, (now.getTime() - Date.parse(target.feedback_at!)) / DAY)
    const evidence = Math.abs(strength) * 0.5 ** (age / HALF_LIFE_DAYS)
    let informative = false
    for (const key of PREFERENCE_KEYS) {
      const value = target.features[key]
      if (value == null) continue
      const others = group.filter(r => r.event_id !== target.event_id && r.features[key] != null)
      if (!others.length) continue // Seeing only one option gives no preference comparison.
      const values = [value, ...others.map(r => r.features[key]!)]
      if (Math.max(...values) - Math.min(...values) < 0.05) continue
      const opposite = others.filter(r => r.feedback && Math.sign(STRENGTH[r.feedback]!) !== Math.sign(strength))
      const reference = opposite.length ? opposite : others
      const mean = reference.reduce((s, r) => s + r.features[key]!, 0) / reference.length
      const advantage = Math.sign(strength) * (value - mean)
      // Exposure position and unobserved reasons can confound choices: use a conservative prior.
      const weight = evidence * (opposite.length ? 1 : 0.25)
      effects[key].sum += weight * advantage
      effects[key].weight += weight
      effects[key].count++
      effects[key].evidence += evidence
      informative = true
    }
    if (informative) {
      seenActions.add(actionKey)
      result.requestCount++
      result.evidence += evidence
    }
  }
  result.evidence = Math.round(result.evidence * 1000) / 1000
  if (result.requestCount < MIN_REQUESTS || result.evidence < MIN_EVIDENCE) {
    result.status = result.requestCount ? 'learning' : 'cold_start'
    return result
  }
  for (const key of PREFERENCE_KEYS) {
    const e = effects[key]
    if (!e.weight || e.count < MIN_REQUESTS || e.evidence < MIN_EVIDENCE) continue
    const confidence = e.weight / (e.weight + 4)
    const direction = clamp((e.sum / e.weight) / 0.25, -1, 1)
    result.multipliers[key] = clamp(1 + 0.4 * confidence * direction, MIN_MULTIPLIER, MAX_MULTIPLIER)
  }
  result.status = PREFERENCE_KEYS.some(k => Math.abs(result.multipliers[k] - 1) > 0.001) ? 'personalised' : 'learning'
  return result
}

/** Context is split so distance and time can be learned independently. */
export function nominalWeights(profile: PersonalWeights, hasOrigin: boolean): Record<PreferenceKey | 'seats', number> {
  const base = { query: 0.3, semantic: 0.25, interest: 0.2, time: hasOrigin ? 0.0675 : 0.1125,
    distance: hasOrigin ? 0.06 : 0, seats: hasOrigin ? 0.0225 : 0.0375, quality: 0.1 }
  for (const k of PREFERENCE_KEYS) {
    const multiplier = profile.status === 'personalised' ? profile.multipliers[k] : 1
    base[k] *= typeof multiplier === 'number' && Number.isFinite(multiplier) ? clamp(multiplier, MIN_MULTIPLIER, MAX_MULTIPLIER) : 1
  }
  const total = Object.values(base).reduce((s, v) => s + v, 0)
  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v / total])) as typeof base
}

export function adaptiveScore(features: PreferenceFeatures, profile: PersonalWeights, hasOrigin: boolean): number {
  const weights = nominalWeights(profile, hasOrigin)
  let total = 0, used = 0
  for (const key of [...PREFERENCE_KEYS, 'seats'] as const) {
    const value = features[key]
    if (value == null || !Number.isFinite(value)) continue
    total += weights[key] * clamp(value, 0, 1)
    used += weights[key]
  }
  return used ? clamp(total / used, 0, 1) : 0
}
