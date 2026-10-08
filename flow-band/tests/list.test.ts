import { expect, test } from 'claude-code/testing'

import { fitQualified, followOffset, isLiveSessionGuard, isRun, noticeText, pageOffset, qualifiedWidth, TASK_ARGS, visible } from '../hooks/list'
import type { TaskRow } from '../types'

const row = (slug: string, extra: Partial<TaskRow> = {}): TaskRow => ({
  slug,
  name: slug,
  status: 'in-progress',
  priority: 'medium',
  project: '',
  tags: [],
  live: false,
  stale: false,
  staleDays: null,
  waitingOn: null,
  updated: null,
  dueInDays: null,
  dueLabel: null,
  ...extra,
})

const slugs = (rows: TaskRow[]) => rows.map(t => t.slug)

test('in-progress tasks and playbook runs only', () => {
  expect(TASK_ARGS).toEqual(['list', 'tasks', '--kind', 'all', '--status', 'in-progress', '--format', 'json'])
})

test('search is a substring of slug, name, project or a tag', () => {
  const rows = [
    row('api-migration', { project: 'platform-operations' }),
    row('cost-review', { name: 'Cost review round two', tags: ['aws'] }),
  ]
  expect(slugs(visible(rows, 'MIGR', 'priority'))).toEqual(['api-migration'])
  expect(slugs(visible(rows, 'platform', 'priority'))).toEqual(['api-migration'])
  expect(slugs(visible(rows, 'round', 'priority'))).toEqual(['cost-review'])
  expect(slugs(visible(rows, 'aws', 'priority'))).toEqual(['cost-review'])
  expect(slugs(visible(rows, 'fbp', 'priority'))).toEqual([])
})

test('priority sort: high first, then slug', () => {
  const rows = [row('b', { priority: 'low' }), row('c', { priority: 'high' }), row('a', { priority: 'high' })]
  expect(slugs(visible(rows, '', 'priority'))).toEqual(['a', 'c', 'b'])
})

test('recently updated: newest first, missing last', () => {
  const rows = [row('old', { updated: '2026-09-01T10:00:00+05:30' }), row('none'), row('new', { updated: '2026-10-06T10:00:00+05:30' })]
  expect(slugs(visible(rows, '', 'recent'))).toEqual(['new', 'old', 'none'])
})

test('a live-session refusal counts as already open', () => {
  expect(isLiveSessionGuard('error: task is already running elsewhere; use --force')).toBe(true)
  expect(isLiveSessionGuard('error: no such task')).toBe(false)
})

test('playbook runs are told apart by their timestamped slug', () => {
  expect(isRun('weekly-sync--2026-10-07-05-55')).toBe(true)
  expect(isRun('api-migration')).toBe(false)
  expect(isRun('a--b')).toBe(false)
})

test('project/slug fills exactly one fixed-width column; the project gives way, never the slash', () => {
  const join = (c: { project: string; slug: string }) => c.project + c.slug
  expect(join(fitQualified('cost-management', 'cost-review-2', 40))).toBe('cost-management/cost-review-2'.padEnd(40))
  const tight = join(fitQualified('platform-operations', 'logging-best-practices', 38))
  expect(tight.length).toBe(38)
  expect(tight).toBe('platform-opera…/logging-best-practices')
  expect(join(fitQualified('', 'a-very-long-slug-that-does-not-fit', 16))).toBe('a-very-long-slu…')
  const rows = [row('cost-review-2', { project: 'cost-management' }), row('logging-best-practices', { project: 'platform-operations' })]
  expect(qualifiedWidth(rows, 48)).toBe('platform-operations/logging-best-practices'.length)
  expect(qualifiedWidth(rows, 30)).toBe(30)
})

test('the window follows the cursor with two rows of lookahead, and pages stay in range', () => {
  // 30 rows, 8 at a time.
  expect(followOffset(3, 0, 8, 30)).toBe(0)
  expect(followOffset(6, 0, 8, 30)).toBe(1)
  expect(followOffset(7, 0, 8, 30)).toBe(2)
  expect(followOffset(12, 1, 8, 30)).toBe(7)
  expect(followOffset(6, 6, 8, 30)).toBe(4)
  expect(followOffset(29, 20, 8, 30)).toBe(22)
  expect(followOffset(0, 5, 8, 30)).toBe(0)
  expect(pageOffset(0, 8, 30, 1)).toBe(7)
  expect(pageOffset(20, 8, 30, 1)).toBe(22)
  expect(pageOffset(3, 8, 30, -1)).toBe(0)
  expect(pageOffset(0, 8, 5, 1)).toBe(0)
})

test('a notice reads cleanly out of the cross-session envelope', () => {
  const wrapped = '<cross-session-message from="x">flow-band notice: opened api-delete-controller from the palette. No action needed.</cross-session-message>'
  expect(noticeText(wrapped)).toBe('opened api-delete-controller from the palette')
  expect(noticeText('flow-band notice: switched here from the palette. No action needed.')).toBe('switched here from the palette')
})
