import type { Sort, TaskRow } from '../types'

// Search and sort ported from flow-bar so the
// palette and flow-bar agree on what the list shows and which row Enter opens.

const PRIORITY: Record<string, number> = { high: 0, medium: 1, low: 2 }

const prio = (t: TaskRow) => PRIORITY[t.priority] ?? PRIORITY.medium!
const bySlug = (a: TaskRow, b: TaskRow) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)

// In-progress only, every kind: `--kind all` brings playbook runs in beside regular tasks.
export const TASK_ARGS = ['list', 'tasks', '--kind', 'all', '--status', 'in-progress', '--format', 'json']

// Case-insensitive substring on slug, name, project or any tag.
export function filtered(tasks: readonly TaskRow[], query: string): TaskRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...tasks]
  return tasks.filter(
    t =>
      t.slug.toLowerCase().includes(q) ||
      t.name.toLowerCase().includes(q) ||
      (t.project !== '' && t.project.toLowerCase().includes(q)) ||
      t.tags.some(tag => tag.toLowerCase().includes(q)),
  )
}

function sortRows(rows: TaskRow[], sort: Sort): TaskRow[] {
  if (sort === 'priority') return rows.sort((a, b) => prio(a) - prio(b) || bySlug(a, b))
  const time = (t: TaskRow) => (t.updated ? Date.parse(t.updated) : NaN)
  return rows.sort((a, b) => {
    const da = time(a)
    const db = time(b)
    if (!Number.isNaN(da) && !Number.isNaN(db) && da !== db) return db - da
    if (a.updated !== b.updated) return (b.updated ?? '') > (a.updated ?? '') ? 1 : -1
    return bySlug(a, b)
  })
}

// What the list shows: filter by query, then sort. Enter opens its first row.
export function visible(tasks: readonly TaskRow[], query: string, sort: Sort): TaskRow[] {
  return sortRows(filtered(tasks, query), sort)
}

// flow refusing because the task is live in another tab is not a failure.
export function isLiveSessionGuard(stderr: string): boolean {
  const s = stderr.toLowerCase()
  return s.includes('--force') || s.includes('already running') || s.includes('running session') || s.includes('already open')
}

export const isDueSoon = (t: TaskRow) => t.dueInDays !== null && t.dueInDays <= 3
export const isOverdue = (t: TaskRow) => (t.dueInDays ?? 1) < 0

// A playbook run's slug is its playbook's plus a `--YYYY-MM-DD-HH-MM` stamp; the JSON carries no kind.
export const isRun = (slug: string) => /--\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/.test(slug)

/**
 * Fits `project/slug` into exactly `width` cells. The slug stays whole as long as it fits;
 * the project gives way first (`platform-opera…/`), and the result is padded to `width`.
 */
export function fitQualified(project: string, slug: string, width: number): { project: string; slug: string } {
  const pad = (p: string, sl: string) => ({ project: p, slug: sl.padEnd(width - p.length) })
  if (!project) return pad('', slug.length > width ? `${slug.slice(0, width - 1)}…` : slug)
  if (project.length + 1 + slug.length <= width) return pad(`${project}/`, slug)
  const room = width - slug.length - 2
  if (room >= 3) return pad(`${project.slice(0, room)}…/`, slug)
  return pad('', slug.length > width ? `${slug.slice(0, width - 1)}…` : slug)
}

/** The width of the project/slug column: the longest one shown, within limits. */
export function qualifiedWidth(rows: readonly TaskRow[], cap: number): number {
  const longest = Math.max(0, ...rows.map(t => (t.project ? t.project.length + 1 : 0) + t.slug.length))
  return Math.max(16, Math.min(cap, longest))
}

/**
 * The scroll offset that keeps row `index` inside a window of `limit` rows over `total`, with two
 * rows of lookahead on each side, so fast ↓/↑ never step past the drawn rows and out of the panel.
 */
export function followOffset(index: number, offset: number, limit: number, total: number): number {
  const maxOffset = Math.max(0, total - limit)
  const ahead = limit > 4 ? 2 : 1
  let next = offset
  if (index >= offset + limit - ahead) next = index - limit + ahead + 1
  if (index < offset + ahead) next = index - ahead
  return Math.max(0, Math.min(maxOffset, next))
}

/** The offset one page up or down, kept inside the list. */
export function pageOffset(offset: number, limit: number, total: number, direction: 1 | -1): number {
  return Math.max(0, Math.min(Math.max(0, total - limit), offset + direction * Math.max(1, limit - 1)))
}

/** The sentence inside a flow-band notice, whatever envelope the delivery came wrapped in. */
export function noticeText(text: string): string {
  const match = /flow-band notice:\s*([^<]*?)\.?\s*No action needed\./.exec(text)
  return (match?.[1] ?? text.slice(text.indexOf('flow-band notice:') + 'flow-band notice:'.length).replace(/<[^>]*>/g, '')).trim()
}
