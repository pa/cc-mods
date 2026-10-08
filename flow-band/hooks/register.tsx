import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { FlowInfo, TaskRow } from '../types'
import {
  fitQualified,
  followOffset,
  isDueSoon,
  isLiveSessionGuard,
  isOverdue,
  isRun,
  noticeText,
  pageOffset,
  qualifiedWidth,
  TASK_ARGS,
  visible,
} from './list'

// The palette mirrors flow-bar's task switcher: same tabs, search,
// sort, Enter-opens-first-openable, and `flow do <slug>` to open or focus the task's session.

const COMMANDS = ['flow-switch', 'fs']
// Cross-session notice: after `flow do`, the palette sends the opened task's session a message
// that the mod there consumes in `session.receive` and shows as a toast (its model never sees it).
const NOTICE = 'flow-band notice:'
const NOTICE_WAIT_MS = 8000
const NOTICE_STEP_MS = 1000
const LIMIT = 8

const info = atom({ plugin: 'flow-band', key: 'info' } as const, null)
const isHidden = atom({ plugin: 'flow-band', key: 'isHidden' } as const, false)
const tasks = atom({ plugin: 'flow-band', key: 'tasks' } as const, [])
const filter = atom({ plugin: 'flow-band', key: 'filter' } as const, '')
const sort = atom({ plugin: 'flow-band', key: 'sort' } as const, 'priority')
const isLoading = atom({ plugin: 'flow-band', key: 'isLoading' } as const, false)
const busy = atom({ plugin: 'flow-band', key: 'busy' } as const, null)
const error = atom({ plugin: 'flow-band', key: 'error' } as const, null)
const isOpen = atom({ plugin: 'flow-band', key: 'isOpen' } as const, false)
const offset = atom({ plugin: 'flow-band', key: 'offset' } as const, 0)

// The band's requestId, as last seen: what $.ui.focus needs to move the cursor.
let bandId: string | null = null
// Rows the palette window showed last; the focus hook scrolls against it.
let windowRows = LIMIT

const PRIORITY_COLOR: Record<string, 'error' | 'warning' | 'subtle'> = { high: 'error', medium: 'warning', low: 'subtle' }

// flow's own colors, drawn as glyphs: ● status (green in progress, yellow backlog, dim done),
// ◉ live (cyan), ◔ waiting (yellow), ⚠ stale (red), ◆ due (red overdue, yellow soon), ▶ playbook run.
const STATUS_COLOR: Record<string, string | undefined> = { 'in-progress': 'green', backlog: 'yellow', done: undefined }
const LEGEND = 'PRI H high · M medium · L low   STATE ▶ run · ◉ live · ◔ waiting · ⚠ stale · ◆ due'
const STATE_WIDTH = 9
const TAG_MAX = 32
const PRIORITY_LETTER: Record<string, string> = { high: 'H', medium: 'M', low: 'L' }

type Marks = { run?: boolean; live?: boolean; waitingOn: string | null; staleDays?: number | null; due?: { isOverdue: boolean } | null }

function statusDot(ui: Els, status: string | null) {
  const { Text } = ui
  const color = STATUS_COLOR[status ?? '']
  return color ? <Text color={color}>●</Text> : <Text dimColor>●</Text>
}

// The palette's STATE column: five fixed slots (run, live, waiting, stale, due), blank when absent,
// so every row's name starts in the same column.
function markSlots(ui: Els, m: Marks) {
  const { Box, Text } = ui
  const slot = (key: string, on: boolean, glyph: string, color: string) => (
    <Text key={key} color={on ? color : undefined}>
      {on ? glyph : ' '}
    </Text>
  )
  return (
    <Box flexDirection="row" gap={1} flexShrink={0} width={STATE_WIDTH}>
      {slot('run', !!m.run, '▶', 'magenta')}
      {slot('live', !!m.live, '◉', 'cyan')}
      {slot('waiting', !!m.waitingOn, '◔', 'yellow')}
      {slot('stale', !!m.staleDays, '⚠', 'red')}
      {slot('due', !!m.due, '◆', m.due?.isOverdue ? 'red' : 'yellow')}
    </Box>
  )
}

// The markers flow puts after a task, one glyph each.
function marks(ui: Els, m: Marks) {
  const { Text } = ui
  return [
    m.live ? <Text key="live" color="cyan">◉</Text> : null,
    m.waitingOn ? <Text key="waiting" color="yellow">◔</Text> : null,
    m.staleDays ? <Text key="stale" color="red">⚠</Text> : null,
    m.due ? <Text key="due" color={m.due.isOverdue ? 'red' : 'yellow'}>◆</Text> : null,
  ].filter(Boolean)
}

const fit = (s: string, n: number) => (n <= 1 ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const firstLine = (s: string) => s.trim().split('\n')[0] ?? ''

type Raw = {
  slug: string
  name: string
  status: string
  priority?: string
  project?: string | null
  tags?: string[] | null
  live?: boolean | null
  stale?: boolean | null
  stale_days?: number | null
  waiting_on?: string | null
  updated?: string | null
  due_in_days?: number | null
  due_label?: string | null
}

const toRow = (t: Raw): TaskRow => ({
  slug: t.slug,
  name: t.name,
  status: t.status,
  priority: t.priority ?? 'medium',
  project: t.project ?? '',
  tags: t.tags ?? [],
  live: !!t.live,
  stale: !!t.stale,
  staleDays: t.stale_days ?? null,
  waitingOn: t.waiting_on ?? null,
  updated: t.updated ?? null,
  dueInDays: t.due_in_days ?? null,
  dueLabel: t.due_label ?? null,
})

// Read-only: a sqlite lookup for this session's binding and `flow inbox` (list, never pop).
async function refresh($: EngineInterface) {
  const home = await $.env.get('HOME')
  const sessionId = (await $.session.id()).replace(/[^A-Za-z0-9-]/g, '')

  let task: string | null = null
  let name: string | null = null
  let project: string | null = null
  let status: string | null = null
  let waitingOn: string | null = null
  let isRun = false
  try {
    const ran = await $.process.run(
      [
        'sqlite3',
        '-readonly',
        '-separator',
        '\t',
        `${home}/.flow/flow.db`,
        `select slug, name, coalesce(project_slug, ''), status, coalesce(waiting_on, ''), kind from tasks where session_id = '${sessionId}' limit 1`,
      ],
      { timeoutMs: 5000 },
    )
    const [slug, title, proj, state, waiting, kind] = ran.exitCode === 0 ? ran.stdout.replace(/\n$/, '').split('\t') : []
    task = slug || null
    name = title || null
    project = proj || null
    status = state || null
    waitingOn = waiting || null
    isRun = kind === 'playbook_run'
  } catch {
    task = null
  }

  let inbox = 0
  try {
    const ran = await $.process.run(['flow', 'inbox', '--as', 'user', '--json'], { timeoutMs: 10000 })
    inbox = ran.exitCode === 0 ? (JSON.parse(ran.stdout || '[]') as unknown[]).length : 0
  } catch {
    inbox = 0
  }

  const next: FlowInfo = { task, name, project, status, waitingOn, isRun, inbox }
  await update($, info, () => next)
}

// In-progress tasks and playbook runs (read-only).
async function loadTasks($: EngineInterface) {
  await update($, isLoading, () => true)
  try {
    const ran = await $.process.run(['flow', ...TASK_ARGS], { timeoutMs: 10000 })
    if (ran.exitCode !== 0) {
      await update($, error, () => firstLine(ran.stderr) || 'flow list tasks failed')
      return
    }
    const rows = (JSON.parse(ran.stdout || '[]') as Raw[]).map(toRow)
    await update($, tasks, () => rows)
  } catch (err) {
    await update($, error, () => `could not read tasks: ${String(err)}`)
  } finally {
    await update($, isLoading, () => false)
  }
}

// flow-bar's prepareForOpen: fresh search, Priority, fresh list, then focus the search box.
async function openPalette($: EngineInterface) {
  await update($, filter, () => '')
  await update($, offset, () => 0)
  await update($, error, () => null)
  await update($, sort, () => 'priority')
  await update($, isHidden, () => false)
  await update($, isOpen, () => true)
  await update($, tasks, () => [])
  await loadTasks($)
  // Lands only while the band holds the keys (after ctrl+f or a click); otherwise a no-op.
  if (bandId) await $.ui.focus({ requestId: bandId, key: 'q' }).catch(() => undefined)
}

async function closePalette($: EngineInterface) {
  await update($, isOpen, () => false)
  await update($, filter, () => '')
}

// The session bound to a task, from flow's db (read-only); null until it has bound.
async function sessionOf($: EngineInterface, slug: string): Promise<string | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(slug)) return null
  try {
    const home = await $.env.get('HOME')
    const ran = await $.process.run(
      ['sqlite3', '-readonly', `${home}/.flow/flow.db`, `select session_id from tasks where slug = '${slug}' limit 1`],
      { timeoutMs: 5000 },
    )
    return ran.exitCode === 0 ? ran.stdout.trim() || null : null
  } catch {
    return null
  }
}

// Runs detached after `flow do`: wait for the task's session to bind (a new tab takes a moment), then push the notice.
async function notifyOpened($: EngineInterface, slug: string, outcome: 'opened' | 'already-open') {
  const me = await $.session.id()
  for (let waited = 0; waited <= NOTICE_WAIT_MS; waited += NOTICE_STEP_MS) {
    const target = await sessionOf($, slug)
    if (target && target !== me) {
      const what = outcome === 'opened' ? `opened ${slug} from the palette` : `switched here from the palette`
      await $.session.send({ to: { sessionId: target }, text: `${NOTICE} ${what}. No action needed.` }).catch(() => undefined)
      return
    }
    await $.clock.sleep(NOTICE_STEP_MS)
  }
}

// flow-bar's switchTo: `flow do <slug>` opens or focuses the task's own session in the
// terminal; this session is untouched. Run as if from outside Claude, as flow-bar does.
async function openTask($: EngineInterface, slug: string): Promise<'opened' | 'already-open' | 'failed'> {
  await update($, busy, () => slug)
  await update($, error, () => null)
  try {
    const ran = await $.process.run(['flow', 'do', slug], {
      env: { CLAUDE_CODE_SESSION_ID: '', CLAUDECODE: '' },
      timeoutMs: 30000,
    })
    if (ran.exitCode === 0 || isLiveSessionGuard(ran.stderr)) {
      const outcome = ran.exitCode === 0 ? 'opened' : 'already-open'
      await closePalette($)
      // The toast shows in the opened task's session, not here; delivered when it has bound.
      void notifyOpened($, slug, outcome)
      return outcome
    }
    const why = firstLine(ran.stderr) || firstLine(ran.stdout) || `exit ${ran.exitCode}`
    await update($, error, () => `open ${slug} failed: ${why}`)
    return 'failed'
  } catch (err) {
    await update($, error, () => String(err))
    return 'failed'
  } finally {
    await update($, busy, () => null)
  }
}

type Els = Elements['terminal'] | Elements['desktop']

// Collapsed: one row with this session's task and Switch. Switch is autoFocus, so ctrl+f
// (abovePrompt:focus) lands on it and the ui.focus hook opens the palette. ⌃F stays last: see the hook.
async function band($: EngineInterface, ui: Els, width: number, maxRows: number) {
  return (await read($, isOpen)) ? palette($, ui, width, maxRows) : flowRow($, ui, width)
}

// The flow row: this session's task, inbox, Switch / Hide / ⌃F.
async function flowRow($: EngineInterface, ui: Els, width: number) {
  const { Box, Button, Text } = ui
  const current = await read($, info)
  return (
    <Box flexDirection="row" gap={1} width={width}>
      <Text color="claude" bold>
        flow
      </Text>
      {current?.task ? (
        <Box flexDirection="row" gap={1} flexShrink={1}>
          <Text color="claude">▸</Text>
          {statusDot(ui, current.status)}
          {current.isRun && <Text color="claude">▶</Text>}
          <Text>
            {current.project && <Text dimColor>{current.project}/</Text>}
            <Text bold>{current.task}</Text>
          </Text>
          {marks(ui, { waitingOn: current.waitingOn })}
        </Box>
      ) : (
        <Text color="warning">▸ not bound</Text>
      )}
      <Box flexGrow={1} />
      {current && current.inbox > 0 && <Text color="suggestion">✉ {current.inbox}</Text>}
      <Button key="switch" hotkey="s" label="Switch" variant="primary" autoFocus onPress={() => openPalette($)} />
      <Button key="hide" hotkey="h" label="Hide" onPress={() => update($, isHidden, () => true)} />
      <Button key="reopen" label="⌃F" plain dimColor onPress={() => openPalette($)} />
    </Box>
  )
}

// One task row, as flow-bar's TaskRow: priority dot, slug, live dot, name, project, tags, due.
type RowLayout = { index: number; slugWidth: number; tagWidth: number }

// Column titles, laid out with the same widths as the rows beneath.
function header(ui: Els, { slugWidth, tagWidth }: { slugWidth: number; tagWidth: number }) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="row" gap={1}>
      <Box flexDirection="row" gap={1} flexShrink={0}>
        <Text> </Text>
        <Box width={3}>
          <Text dimColor>PRI</Text>
        </Box>
        <Box width={slugWidth}>
          <Text dimColor>TASK</Text>
        </Box>
        <Box width={STATE_WIDTH}>
          <Text dimColor>STATE</Text>
        </Box>
      </Box>
      <Box flexGrow={1}>
        <Text dimColor>NAME</Text>
      </Box>
      {tagWidth > 0 && (
        <Box width={tagWidth} flexShrink={0} justifyContent="flex-end">
          <Text dimColor>TAGS</Text>
        </Box>
      )}
    </Box>
  )
}

// One palette row in fixed columns under the header: ↵ · PRI · TASK · STATE · NAME · TAGS.
// TASK stays one line; NAME and TAGS wrap rather than cut, so a long one takes a second line.
function row(ui: Els, t: TaskRow, { index: i, slugWidth, tagWidth }: RowLayout, onPress: () => unknown) {
  const { Box, Button, Text } = ui
  const cell = fitQualified(t.project, t.slug, slugWidth)
  const tags = t.tags.map(x => `#${x}`).join(' ')
  return (
    <Box key={`row:${t.slug}`} flexDirection="row" gap={1}>
      <Box flexDirection="row" gap={1} flexShrink={0}>
        <Text color={i === 0 ? 'claude' : 'subtle'}>{i === 0 ? '↵' : ' '}</Text>
        <Box width={3}>
          <Text color={PRIORITY_COLOR[t.priority] ?? 'warning'} bold>
            {PRIORITY_LETTER[t.priority] ?? 'M'}
          </Text>
        </Box>
        <Box flexDirection="row" width={slugWidth}>
          {cell.project && <Text dimColor>{cell.project}</Text>}
          <Button key={`task:${t.slug}`} plain label={cell.slug} onPress={onPress} />
        </Box>
        {markSlots(ui, {
          run: isRun(t.slug),
          live: t.live,
          waitingOn: t.waitingOn,
          staleDays: t.stale ? t.staleDays : null,
          due: isDueSoon(t) ? { isOverdue: isOverdue(t) } : null,
        })}
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text dimColor wrap="wrap">
          {t.name}
        </Text>
      </Box>
      {tagWidth > 0 && (
        <Box width={tagWidth} flexShrink={0} justifyContent="flex-end">
          <Text color="gray" wrap="wrap">
            {tags}
          </Text>
        </Box>
      )}
    </Box>
  )
}

// The cursor reached ↓ more / ↑ more: page, then put it on the first row that came into view,
// so moving on never falls out of the panel into the prompt.
async function pageFromButton($: EngineInterface, direction: 1 | -1) {
  const hits = visible(await read($, tasks), await read($, filter), await read($, sort))
  const start = await read($, offset)
  const next = pageOffset(start, windowRows, hits.length, direction)
  if (next === start) return
  await update($, offset, () => next)
  const target = direction === 1 ? hits[Math.min(hits.length - 1, start + windowRows)] : hits[Math.max(0, start - 1)]
  if (target && bandId) await $.ui.focus({ requestId: bandId, key: `task:${target.slug}` }).catch(() => undefined)
}

// ↓ / ↑ onto a row near the window's edge scrolls it, so the next rows are always drawn.
async function followRow($: EngineInterface, slug: string) {
  const hits = visible(await read($, tasks), await read($, filter), await read($, sort))
  const index = hits.findIndex(t => t.slug === slug)
  if (index < 0) return
  const current = await read($, offset)
  const next = followOffset(index, current, windowRows, hits.length)
  if (next !== current) await update($, offset, () => next)
}

// Expanded: search box with the sort switch, task rows in a scrolling window, footer.
async function palette($: EngineInterface, ui: Els, width: number, maxRows: number) {
  const { Box, Button, Input, Text } = ui
  const all = await read($, tasks)
  const query = await read($, filter)
  const order = await read($, sort)
  const loading = await read($, isLoading)
  const pending = await read($, busy)
  const problem = await read($, error)

  const limit = Math.max(3, Math.min(LIMIT, maxRows - 9))
  windowRows = limit
  const hits = visible(all, query, order)
  const top = hits[0]
  const count = !query.trim() || hits.length === all.length ? `${all.length}` : `${hits.length} of ${all.length}`
  const start = Math.min(await read($, offset), Math.max(0, hits.length - limit))
  const shown = hits.slice(start, start + limit)
  const above = start
  const below = Math.max(0, hits.length - start - limit)
  // Measured over every match, not the window, so columns hold still while scrolling.
  const slugWidth = qualifiedWidth(hits, Math.min(48, Math.floor(width * 0.4)))
  // Wide enough for the longest tag list up to TAG_MAX; longer lists wrap onto a second line.
  const tagWidth = width >= 110 ? Math.min(TAG_MAX, Math.max(0, ...hits.map(t => t.tags.map(x => `#${x}`).join(' ').length))) : 0
  const page = (direction: 1 | -1) => update($, offset, () => pageOffset(start, limit, hits.length, direction))
  const open = (t: TaskRow) => (pending ? undefined : openTask($, t.slug))

  return (
    <Box flexDirection="column" width={width}>
      <Box borderStyle="round" borderColor="claude" paddingX={1} flexDirection="row" gap={1}>
        <Button key="toggle" label="›" plain onPress={() => closePalette($)} />
        <Box flexGrow={1}>
          <Input
            key="q"
            placeholder="Search in-progress tasks…"
            submitLabel="open"
            value={query}
            autoFocus
            onInput={value => update($, filter, () => value).then(() => update($, offset, () => 0))}
            onSubmit={() => (top && !pending ? openTask($, top.slug) : undefined)}
          />
        </Box>
        <Text dimColor>{count}</Text>
        <Button
          key="sort"
          plain
          dimColor
          label={order === 'priority' ? '⇅ priority' : '⇅ recent'}
          onPress={() => update($, sort, () => (order === 'priority' ? 'recent' : 'priority'))}
        />
        <Button key="close" label="×" plain role="dismiss" onPress={() => closePalette($)} />
      </Box>
      {loading && all.length === 0 && <Text dimColor> Loading…</Text>}
      {!loading && all.length === 0 && !problem && <Text dimColor> No in-progress tasks</Text>}
      {all.length > 0 && hits.length === 0 && <Text dimColor> No matches for "{query}"</Text>}
      {shown.length > 0 && header(ui, { slugWidth, tagWidth })}
      {above > 0 && <Button key="page-up" plain dimColor label={`  ↑ ${above} more`} onPress={() => page(-1)} />}
      {shown.map((t, i) => row(ui, t, { index: start + i, slugWidth, tagWidth }, () => open(t)))}
      {below > 0 && <Button key="page-down" plain dimColor label={`  ↓ ${below} more`} onPress={() => page(1)} />}
      {pending && <Text color="suggestion"> Opening {pending}…</Text>}
      {problem && <Text color="error"> {problem}</Text>}
      <Text dimColor> ↵ open top · ↓↑ move · ctrl+f close · esc prompt</Text>
      <Text dimColor> {LEGEND}</Text>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await refresh($)
    for (const name of COMMANDS) {
      try {
        await $.command.register({ name, description: 'Flow task palette: /fs <search> opens the first match' })
      } catch {
        // The band's Switch button still opens the palette.
      }
    }
    return started
  })

  for (const command of COMMANDS) {
    on('command.run', { command }, async ($, e) => {
      const query = e.args.trim()
      if (!query) {
        await openPalette($)
        return { text: 'Flow palette open above the prompt. ctrl+f to search.' }
      }
      await loadTasks($)
      const top = visible(await read($, tasks), query, 'priority')[0]
      if (!top) return { text: `No in-progress task matches "${query}".` }
      const outcome = await openTask($, top.slug)
      if (outcome === 'opened') return { text: `Opened ${top.slug}.` }
      if (outcome === 'already-open') return { text: `${top.slug} is already open in another tab.` }
      return { text: (await read($, error)) ?? `Could not open ${top.slug}.` }
    })
  }

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refresh($)
    return done
  })

  // A palette in another session opened this task: show its notice as a toast and keep it from the model.
  on('session.receive', async ($, e, next) => {
    if (e.agentId !== undefined || !e.text.includes(NOTICE)) return next(e)
    // The delivery arrives wrapped in Claude Code's envelope (<cross-session-message …>); take only our sentence.
    const what = noticeText(e.text)
    $.ui.toast(`flow: ${what}`)
    return { consumed: 'flow-band notice shown as a toast' }
  })

  // ctrl+f toggles the palette by moving the band's focus ring; where it lands says which way.
  on('ui.focus', { component: 'AbovePrompt' }, async ($, e, next) => {
    const moved = await next(e)
    if (e.plugin !== 'flow-band') return moved
    bandId = e.requestId
    const open = await read($, isOpen)
    if (!open && (e.element === 'reopen' || e.element === 'switch')) {
      // From the prompt, ctrl+f gives the band the keys and autoFocus puts the ring on Switch.
      // After a close the ring is on nothing, and ctrl+f (previous) lands on the last button,
      // ⌃F, which is why it sits at the end of the row. Either way: open.
      await openPalette($)
    } else if (open && e.element === 'toggle' && e.origin.kind === 'person') {
      // ctrl+f from the search box moves the ring back onto ›: close.
      await closePalette($)
    } else if (open && e.element?.startsWith('task:')) {
      await followRow($, e.element.slice('task:'.length))
    } else if (open && e.origin.kind === 'person' && (e.element === 'page-down' || e.element === 'page-up')) {
      void pageFromButton($, e.element === 'page-down' ? 1 : -1)
    }
    return moved
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    bandId = e.requestId
    const current = await read($, info)
    if (e.props.hasSurvey || current === null || (await read($, isHidden))) {
      return next(e)
    }
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    return band($, $.ui.resolve(e), e.props.bodyColumns, e.props.maxRows)
  })
}
