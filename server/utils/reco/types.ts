// Shapes shared by the recommender modules (server/utils/reco) and the API route.

export const ALGORITHM_VERSION = 'reco-v3-adaptive-semantic'

/** Places a search can be "near". "campus" means the searcher's own school. */
export const PLACES = {
  imperial: { lat: 51.4988, lng: -0.1749, label: '帝国理工' },
  ucl: { lat: 51.5246, lng: -0.134, label: 'UCL' },
  lse: { lat: 51.5144, lng: -0.1165, label: 'LSE' },
  oxford: { lat: 51.7548, lng: -1.2544, label: '牛津' },
  cambridge: { lat: 52.2043, lng: 0.1149, label: '剑桥' },
} as const
export type PlaceKey = keyof typeof PLACES | 'campus'
export const PLACE_KEYS = [...Object.keys(PLACES), 'campus'] as PlaceKey[]

export const SCHOOL_PLACE: Record<string, keyof typeof PLACES> = {
  'imperial.ac.uk': 'imperial',
  'ucl.ac.uk': 'ucl',
  'lse.ac.uk': 'lse',
  'ox.ac.uk': 'oxford',
  'cam.ac.uk': 'cambridge',
}

/**
 * What a search asks for. Only `exclude`, `from`/`to` and `maxDistanceKm` are hard constraints,
 * and only because the user said them explicitly; everything else only changes the order.
 */
export interface ParsedQuery {
  keywords: string[]
  categories: string[]
  exclude: string[]
  from: string | null
  to: string | null
  timeLabel: string | null
  place: PlaceKey | null
  maxDistanceKm: number | null
}

export const EMPTY_QUERY: ParsedQuery = {
  keywords: [], categories: [], exclude: [], from: null, to: null, timeLabel: null, place: null, maxDistanceKm: null,
}

/** A row of recommendation_candidates(). */
export interface Candidate {
  id: string
  title: string
  category: string
  description: string
  starts_at: string
  ends_at: string | null
  location_text: string
  location_lat: number | null
  location_lng: number | null
  capacity: number | null
  going: number
  org_verified: boolean
  embedding_hash: string | null
  similarity: number | null
}

/** A row of recommendation_signals(). */
export interface Signal {
  category: string
  signal: 'join' | 'cancel_join' | 'attend' | 'click' | 'dismiss' | string
  at: string
}

export interface Breakdown {
  query: number | null
  semantic: number | null
  interest: number | null
  context: number
  quality: number
}

export interface Ranked {
  candidate: Candidate
  score: number
  breakdown: Breakdown
  reasons: string[]
  /** Server-computed, point-in-time features; never supplied by the browser. */
  features: PreferenceFeatures
}

export const PREFERENCE_KEYS = ['query', 'semantic', 'interest', 'time', 'distance', 'quality'] as const
export type PreferenceKey = (typeof PREFERENCE_KEYS)[number]
export type PreferenceFeatures = Record<PreferenceKey | 'seats', number | null>

export interface WeightObservation {
  request_id: string
  event_id: string
  shown_at: string
  position: number
  features: PreferenceFeatures
  feedback: 'click' | 'dismiss' | 'join' | 'cancel_join' | 'attend' | null
  feedback_at: string | null
}

export interface PersonalWeights {
  status: 'cold_start' | 'learning' | 'personalised' | 'disabled' | 'unavailable'
  requestCount: number
  evidence: number
  multipliers: Record<PreferenceKey, number>
}
