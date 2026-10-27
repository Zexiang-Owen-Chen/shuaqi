// Related words are soft alternatives, never additional required filters.
import { haystack, matches, normalize, type Haystack } from './text'
import type { ParsedQuery } from './types'

const SPORTS = [
  ['羽毛球', 'badminton', 'shuttlecock'],
  ['网球', 'tennis'],
  ['乒乓球', 'table tennis', 'ping pong', 'pingpong'],
  ['篮球', 'basketball'], ['足球', 'football', 'soccer'],
  ['围棋', 'weiqi', 'baduk'], ['国际象棋', 'chess'],
] as const
const DOUBLES = ['双打', '混双', '男双', '女双', 'doubles', 'mixed doubles']
const PICKUP = ['补位', '三缺一', '缺一个', '缺一人', '找球友', '找搭子', 'pickup', 'pick up', 'one more player']
export interface SearchExpansion {
  groups: { terms: string[]; weight: number }[]
  excluded: string[]
  ambiguous: boolean
  embeddingText: string
  explicitSports: string[]
}
const sportHits = (text: string) => {
  const h = haystack(text)
  // "table tennis" must not simultaneously imply lawn tennis.
  return SPORTS.filter((s, i) => s.some(t => matches(h, t)) && !(i === 1 && SPORTS[2].some(t => matches(h, t))))
}

export function buildExpansion(raw: string, query: ParsedQuery, interests: string[], aiTerms: unknown = []): SearchExpansion {
  const excludedSports = sportHits(query.exclude.join(' '))
  const excluded = [...new Set([...query.exclude, ...excludedSports.flatMap(s => [...s])])]
  const blocked = (term: string) => excluded.some(t => normalize(t) === normalize(term))
  const positive = raw.split(/[,，;；]/).filter(s => !/\b(?:no|without|exclude)\b|不要|不想|不打/u.test(s)).join(' ')
  const explicit = sportHits(positive).filter(s => !excludedSports.includes(s))
  const h = haystack(positive)
  const doubles = DOUBLES.some(t => matches(h, t)) && !query.exclude.some(t => DOUBLES.includes(t))
  const pickup = PICKUP.some(t => matches(h, t))
  const groups: SearchExpansion['groups'] = []
  for (const s of explicit) groups.push({ terms: [...s], weight: .95 })
  if (doubles) groups.push({ terms: DOUBLES, weight: .8 })
  if (pickup) groups.push({ terms: PICKUP, weight: .55 })
  if (doubles && !explicit.length) {
    for (const sport of SPORTS.slice(0, 3)) {
      if (excludedSports.includes(sport)) continue
      const preferred = interests.some(i => sportHits(i).includes(sport))
      groups.push({ terms: [...sport], weight: preferred ? .65 : .45 })
    }
  }
  // Model suggestions only affect recall/ranking. They cannot create events or filters.
  const suggested = [...new Set((Array.isArray(aiTerms) ? aiTerms : [])
    .filter((t): t is string => typeof t === 'string' && t.trim().length >= 2 && t.trim().length <= 30)
    .map(t => t.trim()))].slice(0, 12)
    .filter(t => !blocked(t) && !sportHits(t).some(s => excludedSports.includes(s) || (explicit.length && !explicit.includes(s))))
  if (suggested.length) groups.push({ terms: suggested, weight: .6 })
  const clean = groups.map(g => ({ ...g, terms: g.terms.filter(t => !blocked(t)) })).filter(g => g.terms.length)
  const alternatives = [...new Set(clean.flatMap(g => g.terms))].slice(0, 32)
  return {
    groups: clean, excluded, ambiguous: doubles && !explicit.length,
    explicitSports: explicit.map(s => s[0]),
    embeddingText: `${raw.slice(0, 200)}${alternatives.length ? '\nRelated activity alternatives (not requirements): ' + alternatives.join(', ') : ''}`.slice(0, 1500),
  }
}

/** A clearly different sport in the title must not match merely because both say "doubles". */
export function conflictsWithSport(title: string, expansion: SearchExpansion): boolean {
  const sports = sportHits(title)
  return expansion.explicitSports.length > 0 && sports.length > 0
    && !sports.some(s => expansion.explicitSports.includes(s[0]))
}

export function matchesExclusion(h: Haystack, term: string): boolean {
  // Excluding lawn tennis must not exclude "table tennis" through the shared English word.
  if (normalize(term) === 'tennis') return matches(haystack(h.text.replace(/\btable\s+tennis\b/gi, ' ')), term)
  return matches(h, term)
}

export function expansionScore(text: string, expansion: SearchExpansion): number | null {
  if (!expansion.groups.length) return null
  const h = haystack(text)
  const hits = expansion.groups.filter(g => g.terms.some(t => matches(h, t))).map(g => g.weight)
  // Alternatives do not dilute a match by increasing a keyword denominator.
  return hits.length ? Math.min(1, Math.max(...hits) + (hits.length > 1 ? .05 : 0)) : 0
}
