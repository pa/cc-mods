export type FlowInfo = {
  task: string | null
  name: string | null
  project: string | null
  status: string | null
  waitingOn: string | null
  isRun: boolean
  inbox: number
}

export type Sort = 'priority' | 'recent'

export type TaskRow = {
  slug: string
  name: string
  status: string
  priority: string
  project: string
  tags: string[]
  live: boolean
  stale: boolean
  staleDays: number | null
  waitingOn: string | null
  updated: string | null
  dueInDays: number | null
  dueLabel: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'flow-band': {
      info: FlowInfo | null
      isHidden: boolean
      tasks: TaskRow[]
      filter: string
      sort: Sort
      isLoading: boolean
      busy: string | null
      error: string | null
      isOpen: boolean
      offset: number
    }
  }
}
