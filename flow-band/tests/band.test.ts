import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TASKS = [
  { slug: 'api-migration', name: 'API migration', status: 'in-progress', priority: 'high', project: 'platform-operations', tags: ['aws', 'api', 'gcp', 'infra', 'migration', 'vpc'], live: true, updated: '2026-10-06T10:00:00+05:30' },
  { slug: 'cost-review-2', name: 'Cost review round two', status: 'in-progress', priority: 'medium', project: 'cost-management', tags: [], stale: true, stale_days: 13, waiting_on: 'Sam: approve the resize window', updated: '2026-09-01T10:00:00+05:30' },
  { slug: 'weekly-sync--2026-10-07-05-55', name: 'weekly-sync run', status: 'in-progress', priority: 'medium', project: 'operations', live: true },
]

type World = { bound?: string | null; toasts?: string[]; sent?: { to: string; text: string }[]; bindsAfter?: number; tasks?: object[] }

// The world beneath the plugin: flow, sqlite and files answered from memory.
function world(on: On, ran: string[][], { bound = null, toasts = [], sent = [], bindsAfter = 0, tasks = TASKS }: World = {}) {
  let lookups = 0
  const opened: string[] = []
  mock.env(on, { HOME: '/home/test' })
  const clock = mock.clock(on, { now: Date.parse('2026-10-07T10:00:00+05:30') })
  on('session.send', ($, e) => {
    sent.push({ to: e.to, text: e.text })
    return { isDelivered: true } as never
  })
  on('session.receive', ($, e) => ({ text: e.text }) as never)
  on('session.id', () => ({ value: 'sess-1' }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: '' }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    const out = (stdout: string, exitCode = 0) =>
      ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never
    if (e.argv[0] === 'sqlite3' && (e.argv[3] ?? '').startsWith('select session_id')) {
      lookups += 1
      return out(lookups > bindsAfter ? 'sess-target\n' : '')
    }
    if (e.argv[0] === 'sqlite3') {
      const row = TASKS.find(t => t.slug === bound)
      return out(row ? `${row.slug}\t${row.name}\t${row.project}\t${row.status}\t\tregular\n` : '')
    }
    if (e.argv[1] === 'inbox') return out(JSON.stringify(INBOX))
    if (e.argv[1] === 'list') {
      const at = e.argv.indexOf('--status')
      const status = at >= 0 ? e.argv[at + 1] : null
      return out(JSON.stringify((tasks as typeof TASKS).filter(t => (status ? t.status === status : t.status !== 'done'))))
    }
    if (e.argv[1] === 'do') {
      if (e.argv[2] === 'cost-review-2' && e.argv.includes('--here') === false && opened.includes('cost-review-2')) {
        return { value: { exitCode: 1, stdout: '', stderr: 'task already running; pass --force', isStdoutTruncated: false, isStderrTruncated: false } } as never
      }
      opened.push(e.argv[2] ?? '')
      return out('ok')
    }
    return out('', 1)
  })
  return clock
}

const INBOX = [
  { id: 'm1', created_at: '2026-10-07T08:00:00+05:30', from: { assignee: 'user', task_slug: 'cost-review-2' }, body: 'Resize done' },
  { id: 'm2', created_at: '2026-10-06T08:00:00+05:30', from: { assignee: 'user', task_slug: 'api-migration' }, body: 'Plan ready' },
  { id: 'm3', created_at: '2026-10-05T08:00:00+05:30', from: { assignee: 'user' }, body: 'loose note' },
]

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as never

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: Switch opens the palette; in-progress tasks and runs`, async ($, on) => {
    const ran: string[][] = []
    world(on, ran)
    on('ui.focus', () => ({}) as never)
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true })

    const band = await $.ui.mount({ plugin: 'flow-band', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ text: /not bound/ })).toBeDefined()
    expect(await band.find({ text: /3/ })).toBeDefined()
    expect(await band.find({ type: 'Input', key: 'q' })).toBeUndefined()

    await band.press({ key: 'switch' })
    expect(await band.find({ type: 'Input', key: 'q' })).toBeDefined()
    expect(await band.find({ type: 'Button', key: 'task:cost-review-2' })).toBeDefined()

    await band.input({ key: 'q', text: 'migr', kind: 'change' })
    expect(await band.find({ type: 'Button', key: 'task:cost-review-2' })).toBeUndefined()
    await band.input({ key: 'q', text: 'migr' })
    expect(ran).toContainEqual(['flow', 'do', 'api-migration'])
    expect(await band.find({ type: 'Input', key: 'q' })).toBeUndefined()

    // A row opens too; picking it again while it is live counts as already open, not a failure.
    await band.press({ key: 'switch' })
    await band.press({ key: 'task:cost-review-2' })
    expect(ran).toContainEqual(['flow', 'do', 'cost-review-2'])
    await band.press({ key: 'switch' })
    await band.press({ key: 'task:cost-review-2' })
    expect(await band.find({ type: 'Input', key: 'q' })).toBeUndefined()

    // Playbook runs list beside tasks.
    await band.press({ key: 'switch' })

    // flow's convention: project/slug, and one colored glyph per marker instead of text.
    expect(await band.find({ text: 'platform-operations/' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '◉' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '◔' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '⚠' })).toBeDefined()
    expect(await band.find({ text: /\[live\]|\[waiting|stale 13d/ })).toBeUndefined()
    // A tag list longer than the column wraps instead of losing tags.
    const tagCell = await band.find({ type: 'Text', text: '#aws #api #gcp #infra #migration #vpc' })
    expect(tagCell?.props).toMatchObject({ wrap: 'wrap' })

    // Every column is labeled and every glyph explained.
    for (const title of ['PRI', 'TASK', 'STATE', 'NAME', 'TAGS']) expect(await band.find({ type: 'Text', text: title })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'H' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'M' })).toBeDefined()
    expect(await band.find({ text: /PRI H high · M medium · L low +STATE ▶ run · ◉ live · ◔ waiting · ⚠ stale · ◆ due/ })).toBeDefined()
    expect(await band.find({ type: 'Button', key: 'task:weekly-sync--2026-10-07-05-55' })).toBeDefined()
    expect(await band.find({ text: '▶' })).toBeDefined()

    // In-progress only: no tabs, no inbox list, nothing else fetched.
    expect(await band.find({ type: 'Button', key: 'tab:inbox' })).toBeUndefined()
    expect(ran.filter(a => a[1] === 'list').every(a => a.join(' ') === 'flow list tasks --kind all --status in-progress --format json')).toBe(true)

    // × closes without opening anything.
    await band.press({ key: 'close' })
    expect(await band.find({ type: 'Input', key: 'q' })).toBeUndefined()
  })
}

test('ctrl+f toggles: autoFocus on Switch opens, › closes, ⌃F reopens', async ($, on) => {
  const ran: string[][] = []
  world(on, ran)
  const moves: string[] = []
  on('ui.focus', ($, e) => {
    const raw = e as unknown as { element?: string; key?: string }
    moves.push(raw.element ?? raw.key ?? '')
    return {} as never
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'flow-band', surface: 'terminal', component: 'AbovePrompt', props: BAND, requestId: 'band' })
  const ring = (element: string, origin: object) =>
    $.ui.focus({ component: 'AbovePrompt', requestId: 'band', plugin: 'flow-band', element, origin } as never)

  // ctrl+f from the prompt: the band takes the keys and autoFocus lands on Switch.
  await ring('switch', { kind: 'plugin', name: 'flow-band' })
  expect(await band.find({ type: 'Input', key: 'q' })).toBeDefined()

  // ctrl+f in the search box: previous lands on ›.
  await ring('toggle', { kind: 'person' })
  expect(await band.find({ type: 'Input', key: 'q' })).toBeUndefined()
  expect(await band.find({ type: 'Button', key: 'switch' })).toBeDefined()

  // ctrl+f again: the ring is on nothing after the close, so previous lands on the last button, ⌃F.
  await ring('reopen', { kind: 'person' })
  expect(await band.find({ type: 'Input', key: 'q' })).toBeDefined()

  // The engine reports the band taking the keys as the person's move: that opens too.
  await ring('toggle', { kind: 'person' })
  expect(await band.find({ type: 'Input', key: 'q' })).toBeUndefined()
  await ring('switch', { kind: 'person' })
  expect(await band.find({ type: 'Input', key: 'q' })).toBeDefined()
})

test('/fs <query> opens the first match', async ($, on) => {
  const ran: string[][] = []
  world(on, ran)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const out = await $.command.run({ command: 'fs', args: 'migr' } as never)
  expect(out.text).toBe('Opened api-migration.')
  expect(ran).toContainEqual(['flow', 'do', 'api-migration'])
  expect((await $.command.run({ command: 'fs', args: 'zzz' } as never)).text).toBe('No in-progress task matches "zzz".')
})

test('opening a task pushes a notice to its session once it binds, and toasts nothing here', async ($, on) => {
  const ran: string[][] = []
  const toasts: string[] = []
  const sent: { to: string; text: string }[] = []
  const clock = world(on, ran, { toasts, sent, bindsAfter: 2 })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  expect((await $.command.run({ command: 'fs', args: 'migr' } as never)).text).toBe('Opened api-migration.')
  expect(sent).toEqual([])
  await clock.advance(3000)
  expect(sent.length).toBe(1)
  expect(sent[0]!.text).toBe('flow-band notice: opened api-migration from the palette. No action needed.')
  expect(sent[0]!.to).toContain('sess-target')
  expect(toasts).toEqual([])
})

test('the opened session turns the notice into a toast and keeps it from the model', async ($, on) => {
  const ran: string[][] = []
  const toasts: string[] = []
  world(on, ran, { toasts })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const notice = await $.session.receive({
    origin: { kind: 'peer', plugin: 'flow-band' },
    text: '<cross-session-message from="sess-1">flow-band notice: opened api-migration from the palette. No action needed.</cross-session-message>',
  } as never)
  expect(notice).toMatchObject({ consumed: 'flow-band notice shown as a toast' })
  expect(toasts).toEqual(['flow: opened api-migration from the palette'])

  const other = await $.session.receive({ origin: { kind: 'peer' }, text: 'hello from a teammate' } as never)
  expect(other).toMatchObject({ text: 'hello from a teammate' })
  expect(toasts.length).toBe(1)
})

test('the flow row names the bound task as project/slug with its status', async ($, on) => {
  const ran: string[][] = []
  world(on, ran, { bound: 'api-migration' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'flow-band', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ text: 'platform-operations/' })).toBeDefined()
  expect(await band.find({ text: 'api-migration' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '●' })).toBeDefined()
  expect(await band.find({ text: /\[IP\]|API migration/ })).toBeUndefined()
})

test('the list scrolls: ↓/↑ follow, ↓ more pages, typing jumps back to the top', async ($, on) => {
  const ran: string[][] = []
  const many = Array.from({ length: 20 }, (_, i) => ({
    slug: `task-${String(i).padStart(2, '0')}`,
    name: `Task ${i}`,
    status: 'in-progress',
    priority: 'medium',
    project: 'p',
    tags: [],
  }))
  world(on, ran, { tasks: many })
  on('ui.focus', () => ({}) as never)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const tall = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120 } as never
  const band = await $.ui.mount({ plugin: 'flow-band', surface: 'terminal', component: 'AbovePrompt', props: tall, requestId: 'band' })
  const ring = (element: string) =>
    $.ui.focus({ component: 'AbovePrompt', requestId: 'band', plugin: 'flow-band', element, origin: { kind: 'person' } } as never)

  await band.press({ key: 'switch' })
  expect(await band.find({ type: 'Button', key: 'task:task-07' })).toBeDefined()
  expect(await band.find({ type: 'Button', key: 'task:task-08' })).toBeUndefined()
  expect(await band.find({ type: 'Button', key: 'page-up' })).toBeUndefined()
  expect((await band.find({ type: 'Button', key: 'page-down' }))?.props).toMatchObject({ label: '  ↓ 12 more' })

  // Tab onto the last visible row: the window moves so the next row is drawn.
  await ring('task:task-07')
  expect(await band.find({ type: 'Button', key: 'task:task-08' })).toBeDefined()
  expect(await band.find({ type: 'Button', key: 'task:task-00' })).toBeUndefined()

  // Arrowing onto ↓ more pages the list instead of falling out of the panel.
  const before = await band.find({ type: 'Button', key: 'task:task-12' })
  expect(before).toBeUndefined()
  await ring('page-down')
  expect(await band.find({ type: 'Button', key: 'task:task-12' })).toBeDefined()

  // Page down to the end, then back up.
  await band.press({ key: 'page-down' })
  expect(await band.find({ type: 'Button', key: 'task:task-19' })).toBeDefined()
  expect(await band.find({ type: 'Button', key: 'page-down' })).toBeUndefined()
  await band.press({ key: 'page-up' })
  expect(await band.find({ type: 'Button', key: 'task:task-19' })).toBeUndefined()

  // Typing resets to the top of the new matches.
  await band.input({ key: 'q', text: 'task-1', kind: 'change' })
  expect(await band.find({ type: 'Button', key: 'task:task-10' })).toBeDefined()
  expect(await band.find({ type: 'Button', key: 'page-up' })).toBeUndefined()
})
