// Text matching for the recommender. Latin words match whole words only ("ai" never matches
// "training"); Chinese has no spaces, so a Chinese term of two or more characters matches as a
// substring ("篮球" in "周六篮球局"), and a single character never matches on its own.

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

const HAN = /\p{Script=Han}/u

const STOPWORDS = new Set([
  // English
  'a', 'an', 'and', 'any', 'are', 'at', 'be', 'by', 'can', 'do', 'for', 'from', 'get', 'go', 'going', 'have', 'i',
  'im', 'in', 'is', 'it', 'like', 'looking', 'me', 'my', 'of', 'on', 'or', 'please', 'some', 'something', 'that',
  'the', 'there', 'this', 'to', 'try', 'want', 'wanna', 'we', 'where', 'with', 'would', 'you', 'event', 'events',
  'activity', 'activities', 'find', 'show', 'recommend', 'near', 'nearby', 'around', 'campus',
  // Chinese
  '我', '我们', '想', '想要', '要', '找', '一个', '一些', '有', '没有', '的', '了', '和', '跟', '或者', '在', '去', '参加',
  '活动', '推荐', '一起', '可以', '什么', '哪里', '附近', '学校', '吗', '呢', '吧', '请', '帮', '帮我', '看看',
])

/** Lower case, full-width to half-width, punctuation to spaces. */
export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

/** Words of a text, Chinese segmented, stopwords and one-letter Latin words dropped. */
export function terms(text: string): string[] {
  const out: string[] = []
  for (const { segment, isWordLike } of segmenter.segment(normalize(text))) {
    if (!isWordLike) continue
    if (STOPWORDS.has(segment)) continue
    if (segment.length < 2) continue
    out.push(segment)
  }
  return [...new Set(out)]
}

/** Prepared text for repeated matching. */
export interface Haystack {
  text: string
  words: Set<string>
}

export function haystack(text: string): Haystack {
  const norm = normalize(text)
  const words = new Set<string>()
  for (const { segment, isWordLike } of segmenter.segment(norm)) if (isWordLike) words.add(segment)
  return { text: ` ${norm} `, words }
}

/** Whether a term or phrase occurs in the text, by the rules at the top of this file. */
export function matches(h: Haystack, term: string): boolean {
  const t = normalize(term)
  if (!t) return false
  if (HAN.test(t)) return t.replace(/\s/g, '').length >= 2 && h.text.replace(/\s/g, '').includes(t.replace(/\s/g, ''))
  if (t.includes(' ')) return h.text.includes(` ${t} `)
  // Plural or singular of the same English word.
  return h.words.has(t) || h.words.has(`${t}s`) || (t.length > 3 && t.endsWith('s') && h.words.has(t.slice(0, -1)))
}
