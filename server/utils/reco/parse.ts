// Turns a search into a ParsedQuery without any AI: dates in London time, categories by synonym,
// explicit exclusions and distances, known places. Also validates what a language model returns,
// so a model can never add a hard constraint the rules here would not accept.
import { EVENT_CATEGORIES } from '../../../app/utils/eventFormat'
import { normalize, terms } from './text'
import { EMPTY_QUERY, PLACE_KEYS, type ParsedQuery, type PlaceKey } from './types'

export const LONDON = 'Europe/London'
const DAY = 86_400_000

// ---------------------------------------------------------------------------
// London calendar arithmetic
// ---------------------------------------------------------------------------
interface Ymd { y: number; m: number; d: number }

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  weekday: 'short', hourCycle: 'h23',
})
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function londonParts(t: number) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]))
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour!, min: +p.minute!, dow: WEEKDAYS.indexOf(p.weekday!) }
}

function offsetMs(t: number): number {
  const p = londonParts(t)
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Math.floor(t / 60_000) * 60_000
}

/** The instant a London calendar day starts, plus `hours`. */
export function londonTime(day: Ymd, hours = 0): Date {
  const guess = Date.UTC(day.y, day.m - 1, day.d, hours)
  let t = guess - offsetMs(guess)
  const again = guess - offsetMs(t)
  if (again !== t) t = again
  return new Date(t)
}

function addDays(day: Ymd, n: number): Ymd {
  const d = new Date(Date.UTC(day.y, day.m - 1, day.d + n))
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }
}

/** London local time with offset, e.g. 2026-10-19T19:00:00+01:00 (Monday), for the model prompt. */
export function londonNowLabel(now: Date): string {
  const p = londonParts(now.getTime())
  const off = offsetMs(now.getTime()) / 60_000
  const pad = (n: number) => String(n).padStart(2, '0')
  const sign = off >= 0 ? '+' : '-'
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][p.dow]
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.min)}:00${sign}${pad(Math.abs(off) / 60 | 0)}:${pad(Math.abs(off) % 60)} (${day})`
}

// ---------------------------------------------------------------------------
// Time phrases
// ---------------------------------------------------------------------------
const DOW_WORDS: [RegExp, number][] = [
  [/(?:\bmon(?:day)?\b|周一|星期一|礼拜一)/, 1], [/(?:\btue(?:s|sday)?\b|周二|星期二|礼拜二)/, 2],
  [/(?:\bwed(?:nesday)?\b|周三|星期三|礼拜三)/, 3], [/(?:\bthu(?:rs|rsday)?\b|周四|星期四|礼拜四)/, 4],
  [/(?:\bfri(?:day)?\b|周五|星期五|礼拜五)/, 5], [/(?:\bsat(?:urday)?\b|周六|星期六|礼拜六)/, 6],
  [/(?:\bsun(?:day)?\b|周日|周天|星期日|星期天|礼拜天|礼拜日)/, 0],
]

interface TimeMatch { from: Date; to: Date; label: string; words: string[] }

export function parseTime(text: string, now: Date): TimeMatch | null {
  const q = text.toLowerCase()
  const p = londonParts(now.getTime())
  const today: Ymd = { y: p.y, m: p.m, d: p.d }
  const daysSinceMonday = (p.dow + 6) % 7
  const monday = addDays(today, -daysSinceMonday)
  const at = (day: Ymd, h = 0) => londonTime(day, h)
  const later = (a: Date) => (a.getTime() < now.getTime() ? now : a)

  const next = /\bnext\b|下周|下个?星期|下礼拜/.test(q)
  if (/\b(?:this\s+|next\s+)?weekend\b|周末/.test(q)) {
    const sat = addDays(monday, 5 + (next ? 7 : 0))
    return { from: later(at(sat)), to: at(addDays(sat, 2)), label: next ? '下周末' : '本周末', words: ['weekend', '周末', '下周末', '本周末', '这周末'] }
  }
  for (const [re, dow] of DOW_WORDS) {
    if (!re.test(q)) continue
    let day = addDays(monday, (dow + 6) % 7)
    if (next) day = addDays(day, 7)
    else if (day.y * 1e4 + day.m * 100 + day.d < today.y * 1e4 + today.m * 100 + today.d) day = addDays(day, 7)
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return { from: later(at(day)), to: at(addDays(day, 1)), label: (next ? '下' : '') + names[dow], words: [] }
  }
  if (/\btonight\b|今晚|今天晚上/.test(q)) {
    return { from: later(at(today, 17)), to: at(addDays(today, 1)), label: '今晚', words: ['tonight', '今晚', '今天晚上', '晚上'] }
  }
  if (/\btoday\b|今天|今日/.test(q)) {
    return { from: now, to: at(addDays(today, 1)), label: '今天', words: ['today', '今天', '今日'] }
  }
  if (/\btomorrow\b|明天|明日/.test(q)) {
    const t = addDays(today, 1)
    return { from: at(t), to: at(addDays(t, 1)), label: '明天', words: ['tomorrow', '明天', '明日'] }
  }
  if (/\bnext\s+week\b|下周|下个?星期|下礼拜/.test(q)) {
    const m = addDays(monday, 7)
    return { from: at(m), to: at(addDays(m, 7)), label: '下周', words: ['week', '下周', '下星期', '下个星期'] }
  }
  if (/\bthis\s+week\b|本周|这周|这个?星期|这礼拜/.test(q)) {
    return { from: now, to: at(addDays(monday, 7)), label: '本周', words: ['week', '本周', '这周', '这星期', '这个星期'] }
  }
  return null
}

// ---------------------------------------------------------------------------
// Categories, places, exclusions, distance
// ---------------------------------------------------------------------------
export const CATEGORY_WORDS: Record<(typeof EVENT_CATEGORIES)[number], string[]> = {
  运动: ['sport', 'sports', 'active', 'fitness', 'gym', 'football', 'soccer', 'basketball', 'badminton', 'tennis',
    'volleyball', 'run', 'running', 'climbing', 'bouldering', 'swim', 'swimming', 'yoga', 'cycling', 'table tennis',
    '运动', '健身', '足球', '篮球', '羽毛球', '网球', '排球', '乒乓球', '跑步', '攀岩', '游泳', '瑜伽', '骑行'],
  学习: ['study', 'studying', 'lecture', 'talk', 'workshop', 'seminar', 'coding', 'hackathon', 'career', 'networking',
    'language', 'ai', '学习', '讲座', '自习', '工作坊', '分享会', '编程', '求职', '读书', '语言交换'],
  美食: ['food', 'dinner', 'lunch', 'brunch', 'cooking', 'restaurant', 'hotpot', 'dumplings', 'coffee', 'tea',
    '美食', '吃饭', '晚饭', '午饭', '火锅', '饺子', '做饭', '烹饪', '咖啡', '奶茶', '探店'],
  音乐: ['music', 'concert', 'gig', 'karaoke', 'band', 'choir', 'jam', 'live music', '音乐', '演唱会', '唱歌', '乐队', '合唱', 'k歌'],
  桌游: ['board game', 'board games', 'boardgame', 'boardgames', 'mahjong', 'poker', 'werewolf', 'chess',
    '桌游', '狼人杀', '剧本杀', '麻将', '扑克', '象棋', '围棋'],
  户外: ['outdoor', 'outdoors', 'hike', 'hiking', 'walk', 'picnic', 'camping', 'park', '户外', '徒步', '爬山', '野餐', '露营', '公园', '散步'],
  派对: ['party', 'parties', 'social', 'mixer', 'drinks', 'pub', 'club', 'clubbing', 'meet people', 'new people', 'make friends',
    '派对', '聚会', '社交', '交友', '认识新朋友', '喝酒', '蹦迪', '酒吧'],
  其他: [],
}

const PLACE_WORDS: [RegExp, PlaceKey][] = [
  [/imperial|south kensington|帝国理工|帝国|南肯/, 'imperial'],
  [/\bucl\b|bloomsbury|伦敦大学学院/, 'ucl'],
  [/\blse\b|holborn|政经/, 'lse'],
  [/oxford|牛津/, 'oxford'],
  [/cambridge|剑桥/, 'cambridge'],
  [/\bcampus\b|\buni\b|university|学校|校园|学校附近/, 'campus'],
]

const NEGATION_EN = /\b(?:not|no|except|without|avoid|excluding|nothing)\s+([\p{L}][\p{L}\s]{0,24}?)(?=$|[,.;!?，。；！？]|\s+(?:and|but|or|please|near|this|next|on|at|in)\b)/gu
const NEGATION_ZH = /(?:不要|不想要?|除了|不包括|别|不喜欢|不去)([\p{Script=Han}a-z]{2,8})/gu
const DISTANCE = /(?:within|under|less than|<)\s*(\d+(?:\.\d+)?)\s*(km|kilometres?|kilometers?|miles?|mi)\b|(\d+(?:\.\d+)?)\s*(?:公里|km)\s*(?:以内|之内|内)/

function categoriesIn(text: string): string[] {
  const t = ` ${normalize(text)} `
  const out: string[] = []
  for (const [cat, words] of Object.entries(CATEGORY_WORDS)) {
    if (words.some((w) => (/\p{Script=Han}/u.test(w) ? t.includes(w) : t.includes(` ${w} `)))) out.push(cat)
  }
  return out
}

function exclusionsIn(text: string): string[] {
  const t = normalize(text)
  const out: string[] = []
  for (const m of t.matchAll(NEGATION_EN)) out.push(...terms(m[1]!))
  for (const m of t.matchAll(NEGATION_ZH)) out.push(...terms(m[1]!).slice(0, 1))
  return [...new Set(out)].slice(0, 5)
}

/** Rule-based parse; also the fallback whenever no language model is used or it fails. */
export function parseQuery(query: string, now: Date): ParsedQuery {
  const q = query.slice(0, 200)
  const lower = q.toLowerCase()
  const time = parseTime(q, now)
  const exclude = exclusionsIn(q)
  const place = PLACE_WORDS.find(([re]) => re.test(lower))?.[1] ?? null
  const dist = DISTANCE.exec(lower)
  let maxDistanceKm: number | null = null
  if (dist) {
    const n = Number(dist[1] ?? dist[3])
    maxDistanceKm = /mi/.test(dist[2] ?? '') ? n * 1.609 : n
  }
  const categories = categoriesIn(q)

  const drop = new Set([...exclude, ...(time?.words ?? []), 'next', 'this', 'week', 'within', 'km', 'miles',
    'not', 'no', 'except', 'without', '不要', '不想', '除了'])
  const keywords = terms(q).filter((w) => !drop.has(w) && !/^\d+(\.\d+)?$/.test(w)
    && !DOW_WORDS.some(([re]) => re.test(w)) && !PLACE_WORDS.some(([re]) => re.test(w))).slice(0, 8)

  return sanitize({
    keywords, categories, exclude, place,
    from: time?.from.toISOString() ?? null, to: time?.to.toISOString() ?? null, timeLabel: time?.label ?? null,
    maxDistanceKm,
  }, now).parsed
}

// ---------------------------------------------------------------------------
// Validation (rules output and model output alike)
// ---------------------------------------------------------------------------
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const strList = (v: unknown, n: number, max = 30) =>
  [...new Set((Array.isArray(v) ? v : []).map((x) => str(x, max)).filter(Boolean))].slice(0, n)

/** Keeps only well-formed values; reports which proposed constraints were dropped. */
export function sanitize(raw: unknown, now: Date): { parsed: ParsedQuery; dropped: string[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const dropped: string[] = []
  const parsed: ParsedQuery = { ...EMPTY_QUERY }
  parsed.keywords = strList(r.keywords, 8)
  parsed.categories = strList(r.categories, 3).filter((c) => (EVENT_CATEGORIES as readonly string[]).includes(c))
  parsed.exclude = strList(r.exclude, 5)
  parsed.place = PLACE_KEYS.includes(r.place as PlaceKey) ? (r.place as PlaceKey) : null

  const from = r.from == null ? null : new Date(str(r.from, 40))
  const to = r.to == null ? null : new Date(str(r.to, 40))
  if (from || to) {
    const ok = (d: Date | null) => d === null || !Number.isNaN(d.getTime())
    const span = from && to ? to.getTime() - from.getTime() : 1
    const inRange = (!to || to.getTime() > now.getTime()) && (!from || from.getTime() < now.getTime() + 366 * DAY)
    if (ok(from) && ok(to) && span > 0 && inRange) {
      parsed.from = from?.toISOString() ?? null
      parsed.to = to?.toISOString() ?? null
      parsed.timeLabel = str(r.timeLabel, 20) || null
    } else {
      dropped.push('time')
    }
  }
  if (r.maxDistanceKm != null) {
    const n = Number(r.maxDistanceKm)
    if (Number.isFinite(n) && n >= 0.2 && n <= 50) parsed.maxDistanceKm = n
    else dropped.push('distance')
  }
  return { parsed, dropped }
}
