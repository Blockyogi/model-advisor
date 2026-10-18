// model-advisor: judges each prompt with Haiku 5.5 and, only when a change
// would help, holds it and offers Best / Balanced / Keep. The choice sticks
// until the next accepted pick. Every failure sends the prompt unchanged.

import type { EngineInterface, Register, SessionMessage } from 'claude-code'
import type { AdvisorActive } from '../types'
import { isSkippable, judgeRequest, ownWords, parseVerdict, statedSetup, summarizeTurns, type JudgeFacts, type TurnSummary, type Verdict } from './judge'
import {
  agree, decide, DISAGREE, isMechanical, label, MODELS, modelKey, movesDown, subagentJob, subagentRoute,
  type Decision, type Effort, type Limits, type Setup, type SubagentJob,
} from './picks'
import { questionText, rows } from './reasons'

const ACTIVE = { plugin: 'model-advisor', key: 'active' } as const
const PREVIOUS_TIER = { plugin: 'model-advisor', key: 'previousTier' } as const
const IS_OFF = { plugin: 'model-advisor', key: 'isOff' } as const
const SEEN_EFFORT = { plugin: 'model-advisor', key: 'seenEffort' } as const
// Whether the task the main loop is on is never-route-down; its subagents keep the parent's setup.
const TASK_NEVER_DOWN = { plugin: 'model-advisor', key: 'taskNeverDown' } as const

const JUDGE_TIMEOUT_MS = 6000
// Each session logs under its own key (`log:<session id>`); `log` holds the
// entries written before 18 Oct 2026, when all sessions shared one key.
const LEGACY_LOG_KEY = 'log'
const LOG_PREFIX = 'log:'
const SESSION_LOG_MAX = 500
const SESSION_LOGS_KEPT = 300
const DEFAULT_EFFORT: Record<'haiku' | 'sonnet' | 'opus' | 'fable', Effort> = { haiku: 'medium', sonnet: 'medium', opus: 'medium', fable: 'high' }
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

type $ = EngineInterface
// dismissed: the person closed the question; no-one-to-ask: nothing could show it.
type Choice = 'best' | 'balanced' | 'keep' | 'dismissed' | 'no-one-to-ask' | 'silent'

// Fields added on 18 Oct 2026 are optional: older entries lack them.
// `subagent` entries are from before phase 2, when the judge rated subagents too.
export type LogEntry = {
  at: string
  kind: 'main' | 'subagent'
  session?: string
  // the prompt's number in the session (for a subagent, the prompt it serves)
  turn?: number
  origin?: string
  // until phase 4 (18 Oct 2026) the judge rated the tier itself (`tier`, `confidence`);
  // from then it reports facts (action, scope, novelty, checkable) and finalTier is computed
  tier?: string
  finalTier?: string
  action?: string
  scope?: string
  novelty?: string
  checkable?: boolean
  domain: string
  flags: string[]
  risky?: boolean
  mechanical?: boolean
  confidence?: string
  // a move down ran the judge twice: whether the runs agreed
  agreed?: boolean
  continuation: boolean
  ongoing: boolean
  previousTier?: string
  neverDown?: boolean
  limits?: Limits
  first: boolean
  contextK: number
  current: string
  best?: string
  balanced?: string
  chosen: Choice | 'routed' | 'kept'
  stated?: boolean
  held?: string
  judgeMs: number
}

// The person overrode a pick: in the picker, or with /picks clear.
export type LogEvent = {
  at: string
  kind: 'event'
  event: 'picker-change' | 'picks-clear'
  session?: string
  turn?: number
  from: string
  to?: string
}

// A subagent routed by type and job (v2 phase 2, from 18 Oct 2026).
export type RouteEntry = {
  at: string
  kind: 'route'
  session?: string
  turn?: number
  agent: string
  job: SubagentJob
  // inside a never-route-down task, where every job keeps the parent's setup
  neverDown: boolean
  // an Agent call a subagent made
  nested: boolean
  // what the call was given; absent means inherited
  model?: string
  effort?: string
}

type LogRow = LogEntry | LogEvent | RouteEntry

// Appends run one after another within a session, and each session writes only
// its own key, so sessions running side by side never overwrite each other.
let appending: Promise<void> = Promise.resolve()
function appendLog($: $, row: LogRow): Promise<void> {
  appending = appending.then(async () => {
    try {
      const session = await $.session.id()
      const key = LOG_PREFIX + session
      const log = ((await $.store.get(key)) as LogRow[] | undefined) ?? []
      await $.store.set(key, [...log, { ...row, session }].slice(-SESSION_LOG_MAX))
    } catch {
      // the log is for tuning; never fail a prompt over it
    }
  })
  return appending
}

// Keeps the newest sessions' logs, well inside the store's 4 MiB.
async function pruneLog($: $) {
  try {
    const keys = (await $.store.keys()).filter(k => k.startsWith(LOG_PREFIX))
    for (const key of keys.slice(0, -SESSION_LOGS_KEPT)) await $.store.delete(key)
  } catch {
    // pruning can wait for the next session
  }
}

async function readLog($: $): Promise<LogRow[]> {
  const keys = (await $.store.keys()).filter(k => k === LEGACY_LOG_KEY || k.startsWith(LOG_PREFIX))
  const logs = await Promise.all(keys.map(k => $.store.get(k) as Promise<LogRow[] | undefined>))
  return logs.flatMap(x => x ?? []).sort((a, b) => a.at.localeCompare(b.at))
}

async function showStatus($: $) {
  const [{ value: active }, { value: isOff }] = await Promise.all([$.state.get(ACTIVE), $.state.get(IS_OFF)])
  // A mod cannot move the desktop picker, so while a pick is active this line
  // says what really runs, and how to go back to the picker.
  $.ui.status(isOff ? 'off' : active ? `running ${label(active)} (undo: /picks clear)` : undefined)
}

// The person overrode the pick (picker or /picks clear): it ends, and the log keeps the override.
async function endPick($: $, active: AdvisorActive, event: LogEvent['event'], to?: string) {
  await $.state.set(ACTIVE, null)
  await showStatus($)
  if (event === 'picker-change') $.ui.toast('Model advisor: you changed the model or effort, so its pick is cleared')
  await appendLog($, { at: new Date().toISOString(), kind: 'event', event, turn: await $.session.turns(), from: label(active), to })
}

// The setup the next request will run on: the sticky pick, else the picker's.
// A model change in the picker since the pick took hold ends the pick here,
// before judging, so the prompt is judged against what will really run.
async function currentSetup($: $): Promise<{ setup: Setup; isLatest: boolean }> {
  const [{ value: active }, id] = await Promise.all([$.state.get(ACTIVE), $.session.model()])
  if (active && (active.baseModel === null || modelKey(active.baseModel) === modelKey(id)))
    return { setup: { model: active.model, effort: active.effort }, isLatest: true }
  const model = modelKey(id) ?? 'opus'
  // An alias (`opus`) names the latest; a dated id must be one of ours.
  const isLatest = !/\d/.test(id) || Object.values(MODELS).some(m => id.startsWith(m))
  const { value: seen } = await $.state.get(SEEN_EFFORT)
  const configured = ((await $.settings.read()) as { effortLevel?: string }).effortLevel
  const effort = [seen, configured].find((x): x is Effort => !!x && EFFORTS.includes(x)) ?? DEFAULT_EFFORT[model]
  if (active) await endPick($, active, 'picker-change', label({ model, effort }))
  return { setup: { model, effort }, isLatest }
}

// A plain `claude -p` run (a script, cron) has no one to answer a question, so
// its prompts are not judged. A -p run started from inside a session inherits
// that session's entrypoint; it is judged, and its question logs as no-one-to-ask.
async function isPrintRun($: $): Promise<boolean> {
  return (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'sdk-cli'
}

function stated(text: string): Setup | undefined {
  const found = statedSetup(text)
  const model = found && modelKey(found.model)
  return model ? { model, effort: found.effort as Effort } : undefined
}

// Descriptions waiting for the question they belong to: $.ui.ask takes bare
// labels, so the tool.call hook below adds each row's reasoning to the dialog.
const pendingDescriptions = new Map<string, Record<string, string>>()

// Dismissed, or with no one to ask, it keeps the setup; the log says which.
async function ask($: $, d: Decision, v: Verdict, current: Setup, ctx: Parameters<typeof rows>[3]): Promise<Choice> {
  const options = rows(d, v, current, ctx)
  const question = questionText(d, v, ctx.limits)
  pendingDescriptions.set(question, Object.fromEntries(options.map(o => [o.label, o.description])))
  try {
    const answer = await $.ui.ask(question, { header: 'Model', options: options.map(o => o.label) })
    return options.find(o => o.label === answer)?.choice ?? 'keep'
  } catch {
    return (await $.session.surfaces()).length === 0 ? 'no-one-to-ask' : 'dismissed'
  } finally {
    pendingDescriptions.delete(question)
  }
}

function limitsOf(rateLimits: readonly { kind: string; percentUsed: number }[]) {
  return {
    fiveHour: rateLimits.find(r => r.kind === 'five_hour')?.percentUsed,
    weekly: rateLimits.find(r => r.kind === 'seven_day')?.percentUsed,
  }
}

// Prompts nobody typed or handed off: background-task notices, scheduled runs,
// messages between sessions, observers, channels, the mod's own. Everything
// else is judged: the terminal, the desktop app (an SDK host), the phone, a
// chip's hand-off, and prompts the engine cannot name.
const MACHINE_ORIGINS = new Set<string>([
  'task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'channel',
  'observer', 'observer-activity', 'auto-continuation', 'slack-ping', 'plugin',
])

// The plugin's `about` setting, read when the module loads.
let about = ''

async function judge($: $, text: string, recent: TurnSummary[], facts: Omit<JudgeFacts, 'previousTier'>, timeoutMs: number) {
  const previousTier = (await $.state.get(PREVIOUS_TIER)).value ?? undefined
  const started = Date.now()
  const r = await $.model.complete(judgeRequest(text, recent, { ...facts, previousTier }, timeoutMs, about))
  const verdict = r.isAnswered ? parseVerdict(r.text) : undefined
  if (!verdict) $.ui.log(`model-advisor: judge ${r.isAnswered ? 'reply unreadable' : r.reason}; left as is`, { to: 'debug' })
  return { verdict, ms: Date.now() - started, previousTier }
}

type JudgeFields = 'at' | 'action' | 'scope' | 'novelty' | 'checkable' | 'domain' | 'flags' | 'risky' | 'mechanical' | 'continuation' | 'ongoing'
function entry(v: Verdict, rest: Omit<LogEntry, JudgeFields>): LogEntry {
  return {
    at: new Date().toISOString(),
    action: v.action, scope: v.scope, novelty: v.novelty, checkable: v.checkable, domain: v.domain, flags: v.flags,
    risky: v.risky, mechanical: isMechanical(v), continuation: v.continuation, ongoing: v.ongoing, ...rest,
  }
}

export const register: Register = (on, options) => {
  about = typeof options.about === 'string' ? options.about : ''

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'picks',
      description: 'Model advisor: on, off, clear (back to the picker), log, or status',
      argumentHint: 'on|off|clear|log',
    })
    await showStatus($)
    await pruneLog($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (MACHINE_ORIGINS.has(e.origin.kind)) return next(e)
    const text = ownWords(e.text)
    if ((await $.state.get(IS_OFF)).value || isSkippable(text) || (await isPrintRun($))) return next(e)

    const [rows, usage, { setup: current, isLatest }, turns] = await Promise.all([
      $.session.messages() as Promise<SessionMessage[]>,
      $.session.usage(),
      currentSetup($),
      $.session.turns(),
    ])
    const isFirstPrompt = !rows.some(m => m.role === 'user' && m.text.trim())
    const contextTokens = isFirstPrompt ? 0 : usage.context.tokens ?? 0
    const recent = summarizeTurns(rows)
    const facts = { isFirstPrompt, contextTokens }
    const { verdict, ms, previousTier } = await judge($, text, recent, facts, JUDGE_TIMEOUT_MS)
    if (!verdict) {
      if (isFirstPrompt) $.ui.toast('Model advisor: could not check this prompt, so it runs as set')
      return next(e)
    }

    const statedPick = stated(text)
    const limits = limitsOf(usage.rateLimits)
    const ctx = { current, currentIsLatest: isLatest, stated: statedPick, isFirstPrompt, contextTokens, previousTier, limits }
    let d = decide(verdict, ctx)
    // A move down stands only if a second run agrees; a failed second run holds it.
    let agreed: boolean | undefined
    let judgeMs = ms
    if (movesDown(d, ctx)) {
      const second = await judge($, text, recent, facts, JUDGE_TIMEOUT_MS)
      judgeMs += second.ms
      const checked = agree(d, second.verdict && decide(second.verdict, ctx), verdict, ctx)
      agreed = checked.held !== DISAGREE
      d = second.verdict ? checked : { ...checked, held: 'the second run failed' }
    }
    const chosen: Choice = d.speak
      ? await ask($, d, verdict, current, { contextTokens, isFirstPrompt, limits, isStated: !!statedPick })
      : 'silent'
    const pick = chosen === 'best' ? d.best : chosen === 'balanced' ? d.balanced : undefined
    // Only ongoing work that needs thought sets the tier a later continuation
    // inherits: a push or a quick aside in between leaves it as it was.
    if (verdict.ongoing && !isMechanical(verdict)) {
      await $.state.set(PREVIOUS_TIER, d.tier)
      await $.state.set(TASK_NEVER_DOWN, d.neverDown)
    } else if (d.neverDown) await $.state.set(TASK_NEVER_DOWN, true)
    await appendLog($, entry(verdict, {
      kind: 'main', turn: turns + 1, origin: e.origin.kind, finalTier: d.tier, previousTier, neverDown: d.neverDown, limits,
      first: isFirstPrompt, contextK: Math.round(contextTokens / 1000), current: label(current),
      best: label(d.best), balanced: label(d.balanced), chosen, stated: !!statedPick, held: d.held, agreed, judgeMs,
    }))
    // One brief sign on the first prompt that the advisor checked and found nothing to change.
    if (!pick && isFirstPrompt && chosen === 'silent')
      $.ui.toast(`Model advisor: ${label(current)} fits this work${statedPick ? ' (your prompt names it)' : ''}`)
    if (!pick) return next(e)

    // The pick runs from the next request on, until the next accepted pick,
    // /picks clear, or a change the person makes in the picker.
    const active: AdvisorActive = { ...pick, baseModel: null, baseEffort: null }
    await $.state.set(ACTIVE, active)
    await showStatus($)
    return next(e)
  })

  on('tool.call', { tool: 'AskUserQuestion' }, ($, e, next) => {
    const descriptions = pendingDescriptions.get(e.questions[0]?.question ?? '')
    if (!descriptions) return next(e)
    return next({
      ...e,
      questions: e.questions.map(q => ({ ...q, options: q.options.map(o => ({ ...o, description: descriptions[o.label] ?? o.description })) })),
    })
  })

  // After /clear the next prompt is a fresh start: nothing to continue, and the
  // last task's pick no longer applies.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await $.state.set(PREVIOUS_TIER, null)
      await $.state.set(TASK_NEVER_DOWN, null)
      await $.state.set(ACTIVE, null)
      await showStatus($)
    }
    return next(e)
  })

  // Applies the sticky pick to every main request. A change the person makes
  // themselves (/model, effort) ends it.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const effort = e.effort === undefined ? null : String(e.effort)
    // What the picker sent, so the next prompt is judged against it.
    if (effort && (await $.state.get(SEEN_EFFORT)).value !== effort) await $.state.set(SEEN_EFFORT, effort)
    const { value: active } = await $.state.get(ACTIVE)
    if (!active) return yield* next(e)
    // The person set the picker to the pick itself: the override is no longer needed.
    if (e.model.startsWith(MODELS[active.model]) && effort === active.effort) {
      await $.state.set(ACTIVE, null)
      await showStatus($)
      return yield* next(e)
    }
    if (active.baseModel === null) {
      await $.state.set(ACTIVE, { ...active, baseModel: e.model, baseEffort: effort })
    } else if (active.baseModel !== e.model || active.baseEffort !== effort) {
      await endPick($, active, 'picker-change', `${e.model} · ${effort ?? 'default'}`)
      return yield* next(e)
    }
    return yield* next({ ...e, model: MODELS[active.model], effort: active.effort })
  })

  // Subagents start fresh, so a switch costs no re-read: they are routed by
  // type and job with no question and no judge call. The Agent tool takes an
  // effort as well as a model (agent.spawn can set only the model), so the
  // route is written into the call. A call that names either has decided.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.model !== undefined || e.effort !== undefined) return next(e)
    const agent = e.subagent_type ?? 'general-purpose'
    const job = subagentJob(agent, e.prompt)
    if (!job || (await $.state.get(IS_OFF)).value) return next(e)
    const [{ value: active }, { value: neverDown }] = await Promise.all([$.state.get(ACTIVE), $.state.get(TASK_NEVER_DOWN)])
    // The main loop runs the advisor's pick, which a subagent would not inherit;
    // a subagent's own Agent calls inherit what that subagent runs.
    const nested = e.agentId !== undefined
    const parent = !nested && active ? { model: active.model, effort: active.effort } : undefined
    const route = subagentRoute(job, parent, neverDown === true)
    await appendLog($, {
      at: new Date().toISOString(), kind: 'route', turn: await $.session.turns(), agent, job, neverDown: neverDown === true, nested, ...route,
    })
    return next({ ...e, ...route })
  })

  on('command.run', { command: 'picks' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      await $.state.set(IS_OFF, true)
      await $.state.set(ACTIVE, null)
      await showStatus($)
      return { text: 'Model advisor is off for this session. Prompts and subagents run as Claude Code sets them.' }
    }
    if (arg === 'on') {
      await $.state.set(IS_OFF, false)
      await showStatus($)
      return { text: 'Model advisor is on.' }
    }
    if (arg === 'log') return { text: await logText($) }
    if (arg === 'clear') {
      const { value: active } = await $.state.get(ACTIVE)
      if (active) await endPick($, active, 'picks-clear')
      return {
        text: active
          ? `Dropped the advisor's pick (${label(active)}). Requests now run on what the picker shows.`
          : 'No advisor pick is active. Requests already run on what the picker shows.',
      }
    }
    const [{ value: active }, { value: isOff }] = await Promise.all([$.state.get(ACTIVE), $.state.get(IS_OFF)])
    return {
      text: isOff
        ? 'Model advisor is off for this session. /picks on turns it back on.'
        : active
          ? `Model advisor is on. Running ${label(active)} until the next accepted pick. /picks off, /picks log.`
          : 'Model advisor is on, running the session\'s own model. /picks off, /picks log.',
    }
  })
}

async function logText($: $): Promise<string> {
  const log = await readLog($)
  if (log.length === 0) return 'No picks logged yet.'
  const main = log.filter((x): x is LogEntry => x.kind === 'main')
  const routes = log.filter((x): x is RouteEntry => x.kind === 'route')
  const routed = (job: SubagentJob) => routes.filter(x => !x.neverDown && x.job === job).length
  const count = (c: string) => main.filter(x => x.chosen === c).length
  const events = (event: LogEvent['event']) => log.filter(x => x.kind === 'event' && x.event === event).length
  const asked = main.length - count('silent')
  const lines = log.slice(-15).map(x => {
    const when = x.at.slice(5, 16).replace('T', ' ')
    if (x.kind === 'event')
      return `${when}  ${x.event === 'picks-clear' ? `/picks clear dropped ${x.from}` : `picker changed: ${x.from} -> ${x.to ?? '?'}`}`
    if (x.kind === 'route')
      return `${when}  subagent ${x.agent} (${x.neverDown ? 'never-route-down task' : x.job}) -> ${x.model ?? 'inherited'} · ${x.effort ?? 'inherited'}`
    const what = `${x.finalTier ?? x.tier}/${x.domain}${x.continuation ? ' (continues)' : ''}`
    const pick = x.kind === 'subagent'
      ? `subagent ${x.current} -> ${x.best} (${x.chosen})`
      : x.chosen === 'silent'
        ? `on ${x.current}, silent`
        : `on ${x.current}; Best ${x.best}, Balanced ${x.balanced}; chose ${x.chosen}`
    return `${when}  ${what.padEnd(22)} ${pick}`
  })
  return [
    `${main.length} prompts judged, asked on ${asked}: Best ${count('best')}, Balanced ${count('balanced')}, Keep ${count('keep')}, ` +
      `dismissed ${count('dismissed')}, no one to ask ${count('no-one-to-ask')}.`,
    `After a pick you changed the picker ${events('picker-change')} times and used /picks clear ${events('picks-clear')} times.`,
    `${routes.length} subagents routed by type: ${routed('search')} search, ${routed('review')} review, ${routed('work')} work, ` +
      `${routes.filter(x => x.neverDown).length} kept on the parent.`,
    ...lines,
  ].join('\n')
}
