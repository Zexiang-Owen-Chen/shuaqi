// POST /api/recommendations — ranked events for the signed-in user, optionally for a search.
// Every database call runs with the user's own session: who is asking comes from the session,
// never from the body, and visibility, blocks, rate limits and the feature flag are enforced in
// Postgres (20261020000300_recommendations.sql). The embedding cache and trusted feature
// snapshots use the server-only service role; all reads of user history use their session.
import { createHash } from 'node:crypto'
import { serverSupabaseClient, serverSupabaseServiceRole, serverSupabaseUser } from '#supabase/server'
import { z } from 'zod'
import { EVENT_CATEGORIES } from '../../app/utils/eventFormat'
import { embed, embeddingModelKey, parseWithLlm, type EmbeddingConfig, type LlmConfig } from '../utils/reco/llm'
import { londonNowLabel, parseQuery, sanitize } from '../utils/reco/parse'
import { rank } from '../utils/reco/score'
import { defaultPersonalWeights, learnPersonalWeights, nominalWeights } from '../utils/reco/adaptive'
import type { Json } from '../../app/types/database.types'
import { ALGORITHM_VERSION, PLACES, SCHOOL_PLACE, type Candidate, type ParsedQuery, type Signal } from '../utils/reco/types'
import { cosine } from '../utils/reco/vector'
import { buildExpansion } from '../utils/reco/expansion'

const Body = z.object({
  query: z.string().trim().max(200).default(''),
  category: z.enum(EVENT_CATEGORIES).optional(),
  location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
  limit: z.number().int().min(1).max(30).default(20),
})

// Events embedded per request when the cache is missing or stale.
const EMBED_PER_REQUEST = 24

function eventText(c: Pick<Candidate, 'title' | 'category' | 'description'>): string {
  return `${c.title}\n${c.category}\n${c.description}`.slice(0, 4000)
}
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32)

function fail(status: number, code: string): never {
  throw createError({ statusCode: status, statusMessage: code, data: { error: code } })
}

export default defineEventHandler(async (event) => {
  const claims = await serverSupabaseUser(event).catch(() => null)
  const userId = typeof claims?.sub === 'string' ? claims.sub : null
  if (!userId) fail(401, 'not_authenticated')

  const parsedBody = Body.safeParse(await readBody(event).catch(() => null))
  if (!parsedBody.success) fail(400, 'invalid_request')
  const body = parsedBody.data
  const now = new Date()
  const db = await serverSupabaseClient(event)
  const adaptiveEnabled = process.env.NUXT_DYNAMIC_RECOMMENDATIONS_ENABLED !== 'false'
  const admin = (() => { try { return serverSupabaseServiceRole(event) } catch { return null } })()
  let personalWeights = defaultPersonalWeights(adaptiveEnabled ? 'unavailable' : 'disabled')
  let snapshotsRecorded = false

  const { data: settings } = await db.from('recommendation_settings').select('*').maybeSingle()
  const llmCfg: LlmConfig = { provider: (settings?.llm_provider ?? 'none') as LlmConfig['provider'], model: settings?.llm_model ?? '' }
  const embCfg: EmbeddingConfig = {
    provider: (settings?.embedding_provider ?? 'none') as EmbeddingConfig['provider'], model: settings?.embedding_model ?? '',
  }
  const modelKey = embeddingModelKey(embCfg)
  const wantsAi = Boolean(body.query) && (llmCfg.provider !== 'none' || modelKey !== null)

  const start = await db.rpc('start_recommendation_request', { p_want_llm: wantsAi })
  if (start.error) {
    const code = start.error.message
    if (code === 'rate_limited') fail(429, code)
    if (code === 'feature_disabled') fail(403, code)
    if (code === 'not_authenticated') fail(401, code)
    console.error('[recommendations] start failed', start.error)
    fail(500, 'server_error')
  }
  const { request_id: requestId, llm_allowed: aiAllowed } = start.data as { request_id: string; llm_allowed: boolean }

  // 1. Understand the search. The rules always run; a model, when allowed, refines them.
  let query: ParsedQuery = parseQuery(body.query, now)
  let llm: 'off' | 'used' | 'failed' | 'over_quota' = 'off'
  let dropped: string[] = []
  let relatedTerms: unknown = []
  if (body.query && llmCfg.provider !== 'none') {
    if (!aiAllowed) llm = 'over_quota'
    else {
      try {
        const raw = await parseWithLlm(llmCfg, body.query, londonNowLabel(now))
        if (raw) {
          relatedTerms = typeof raw === 'object' ? (raw as Record<string, unknown>).relatedTerms : []
          const s = sanitize(raw, now)
          dropped = s.dropped
          query = { ...s.parsed, keywords: [...new Set([...s.parsed.keywords, ...query.keywords])].slice(0, 10),
            exclude: [...new Set([...query.exclude, ...s.parsed.exclude])],
            from: query.from ?? s.parsed.from, to: query.to ?? s.parsed.to,
            timeLabel: query.timeLabel ?? s.parsed.timeLabel,
            maxDistanceKm: query.maxDistanceKm ?? s.parsed.maxDistanceKm,
            place: query.place ?? s.parsed.place,
          }
          llm = 'used'
        }
      } catch (err) {
        llm = 'failed'
        console.warn('[recommendations] language model unavailable, using rules', (err as Error).message)
      }
    }
  }

  // 2. Profile and history.
  const [profile, signals] = await Promise.all([
    db.from('profiles').select('interests, school_domain').eq('id', userId).maybeSingle(),
    db.rpc('recommendation_signals'),
  ])
  const interests = (profile.data?.interests ?? []).slice(0, 20)
  const expansion = buildExpansion(body.query, query, interests, relatedTerms)
  const schoolPlace = profile.data?.school_domain ? SCHOOL_PLACE[profile.data.school_domain] : undefined
  const placeKey = query.place === 'campus' ? schoolPlace : query.place ?? undefined
  const origin = body.location ?? (placeKey ? PLACES[placeKey] : null)
  if (adaptiveEnabled && admin) {
    try {
      const history = await db.rpc('recommendation_weight_observations')
      if (history.error) throw history.error
      personalWeights = learnPersonalWeights(history.data ?? [], now)
    } catch {
      console.warn('[recommendations] adaptive history unavailable; using default weights')
    }
  }

  // 3. Query embedding (optional).
  let queryVector: number[] | null = null
  if (body.query && modelKey && aiAllowed) {
    try {
      queryVector = (await embed(embCfg, [expansion.embeddingText]))?.[0] ?? null
    } catch (err) {
      console.warn('[recommendations] embeddings unavailable', (err as Error).message)
    }
  }

  // 4. Candidates: hard constraints from the database.
  const candidateArgs = {
    p_from: query.from ?? undefined,
    p_to: query.to ?? undefined,
    p_embedding_model: modelKey ?? undefined,
    p_query_embedding: queryVector ? `[${queryVector.join(',')}]` : undefined,
    p_limit: 300,
  }
  let cand = await db.rpc('recommendation_search_candidates', {
    ...candidateArgs, p_terms: [...new Set([...query.keywords, ...expansion.groups.flatMap(g => g.terms)])].slice(0, 40),
    p_category: body.category,
  })
  let retrieval: 'expanded' | 'legacy' = 'expanded'
  if (cand.error && ['PGRST202', '42883'].includes(cand.error.code)) {
    // Rolling deploy: semantic rules still work while the new RPC is being migrated.
    retrieval = 'legacy'
    cand = await db.rpc('recommendation_candidates', candidateArgs)
  }
  if (cand.error) {
    console.error('[recommendations] candidates failed', cand.error)
    fail(500, 'server_error')
  }
  let candidates = (cand.data ?? []) as Candidate[]
  if (body.category) candidates = candidates.filter((c) => c.category === body.category)

  // 5. Fill the embedding cache for a few events whose text is new or changed.
  const freshSimilarity = new Map<string, number>()
  if (queryVector && modelKey) {
    const stale = candidates.filter((c) => c.embedding_hash !== hashOf(eventText(c))).slice(0, EMBED_PER_REQUEST)
    if (stale.length) {
      try {
        const vectors = await embed(embCfg, stale.map(eventText))
        if (vectors) {
          stale.forEach((c, i) => freshSimilarity.set(c.id, cosine(queryVector!, vectors[i]!)))
          await admin?.from('event_embeddings').upsert(stale.map((c, i) => ({
            event_id: c.id, model: modelKey, content_hash: hashOf(eventText(c)),
            embedding: `[${vectors[i]!.join(',')}]`, updated_at: now.toISOString(),
          })))
        }
      } catch (err) {
        console.warn('[recommendations] could not embed events', (err as Error).message)
      }
    }
  }

  // 6. Rank.
  const { eligible, ranked } = rank({
    candidates, query, interests, signals: (signals.data ?? []) as Signal[], origin,
    freshSimilarity, hasQueryEmbedding: queryVector !== null, now, limit: body.limit, personalWeights, expansion,
  })

  // Snapshot scores before returning; browser-provided features are never accepted.
  if (adaptiveEnabled && admin && ranked.length) {
    try {
      const saved = await admin.from('recommendation_observations').upsert(ranked.map((r, i) => ({
        user_id: userId, request_id: requestId, event_id: r.candidate.id,
        shown_at: now.toISOString(), position: i, features: r.features as unknown as Json,
        algorithm_version: ALGORITHM_VERSION,
      })), { onConflict: 'user_id,request_id,event_id' })
      if (saved.error) throw saved.error
      snapshotsRecorded = true
      const cleanup = await admin.from('recommendation_observations').delete().eq('user_id', userId)
        .lt('shown_at', new Date(now.getTime() - 90 * 86400000).toISOString())
      if (cleanup.error) console.warn('[recommendations] snapshot retention cleanup failed')
    } catch {
      console.warn('[recommendations] adaptive snapshots not recorded')
    }
  }

  // 7. Impressions, so "shown but ignored" can be told apart from "never shown".
  if (ranked.length) {
    const { error } = await db.from('recommendation_events').insert(ranked.map((r, i) => ({
      event_id: r.candidate.id, kind: 'impression' as const, request_id: requestId, position: i, algorithm_version: ALGORITHM_VERSION,
    })))
    if (error) console.warn('[recommendations] impressions not recorded', error.message)
  }

  const round = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100)
  return {
    request_id: requestId,
    algorithm_version: ALGORITHM_VERSION,
    parsed: query,
    results: ranked.map((r) => ({
      event: {
        id: r.candidate.id, title: r.candidate.title, category: r.candidate.category, starts_at: r.candidate.starts_at,
        ends_at: r.candidate.ends_at, location_text: r.candidate.location_text, status: 'published' as const,
        capacity: r.candidate.capacity,
      },
      score: Math.round(r.score * 100),
      breakdown: Object.fromEntries(Object.entries(r.breakdown).map(([k, v]) => [k, round(v)])),
      reasons: r.reasons,
    })),
    diagnostics: {
      candidates: candidates.length, eligible, returned: ranked.length, llm, semantic: queryVector !== null, dropped,
      expansion: { ambiguous: expansion.ambiguous, groups: expansion.groups.length, retrieval },
      personalisation: {
        status: personalWeights.status, requests: personalWeights.requestCount,
        evidence: personalWeights.evidence, multipliers: personalWeights.multipliers,
        nominalWeights: nominalWeights(personalWeights, origin !== null), snapshotsRecorded,
      },
    },
  }
})
