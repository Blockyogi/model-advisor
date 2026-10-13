// model-advisor: judges each prompt with Haiku 5.5 and, only when a change
// would help, holds it and offers Best / Balanced / Keep. The choice sticks
// until the next accepted pick. Every failure sends the prompt unchanged.

import type { EngineInterface, Register, SessionMessage } from 'claude-code'
import type { AdvisorActive } from '../types'
import { isSkippable, judgeRequest, parseVerdict, statedSetup, type Turn, type Verdict } from './judge'
import { decide, label, MODELS, modelKey, subagentModel, type Decision, type Effort, type Setup } from './picks'
import { questionText, rows } from './reasons'

const ACTIVE = { plugin: 'model-advisor', key: 'active' } as const
const PREVIOUS_TIER = { plugin: 'model-advisor', key: 'previousTier' } as const
const IS_OFF = { plugin: 'model-advisor', key: 'isOff' } as const
const SEEN_EFFORT = { plugin: 'model-advisor', key: 'seenEffort' } as const

const JUDGE_TIMEOUT_MS = 6000
const LOG_KEY = 'log'
const LOG_MAX = 2000
// Subagent types with no model of their own; others keep what their definition says.
const ROUTED_AGENTS = new Set(['general-purpose', 'claude'])
const DEFAULT_EFFORT: Record<'haiku' | 'sonnet' | 'opus' | 'fable', Effort> = { haiku: 'medium', sonnet: 'medium', opus: 'medium', fable: 'high' }
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

type $ = EngineInterface
type Choice = 'best' | 'balanced' | 'keep' | 'silent'

export type LogEntry = {
  at: string
  kind: 'main' | 'subagent'
  tier: string
  domain: string
  flags: string[]
  confidence: string
  continuation: boolean
  ongoing: boolean
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

async function appendLog($: $, entry: LogEntry) {
  try {
    const log = ((await $.store.get(LOG_KEY)) as LogEntry[] | undefined) ?? []
    await $.store.set(LOG_KEY, [...log, entry].slice(-LOG_MAX))
  } catch {
    // the log is for tuning; never fail a prompt over it
  }
}

async function showStatus($: $) {
  const [{ value: active }, { value: isOff }] = await Promise.all([$.state.get(ACTIVE), $.state.get(IS_OFF)])
  // A mod cannot move the desktop picker, so while a pick is active this line
  // says what really runs, and how to go back to the picker.
  $.ui.status(isOff ? 'off' : active ? `running ${label(active)} (undo: /picks clear)` : undefined)
}

// The setup the next request will run on: the sticky pick, else the session's own.
async function currentSetup($: $): Promise<{ setup: Setup; isLatest: boolean }> {
  const { value: active } = await $.state.get(ACTIVE)
  if (active) return { setup: { model: active.model, effort: active.effort }, isLatest: true }
  const id = await $.session.model()
  const model = modelKey(id) ?? 'opus'
  // An alias (`opus`) names the latest; a dated id must be one of ours.
  const isLatest = !/\d/.test(id) || Object.values(MODELS).some(m => id.startsWith(m))
  const { value: seen } = await $.state.get(SEEN_EFFORT)
  const configured = ((await $.settings.read()) as { effortLevel?: string }).effortLevel
  const effort = [seen, configured].find((x): x is Effort => !!x && EFFORTS.includes(x)) ?? DEFAULT_EFFORT[model]
  return { setup: { model, effort }, isLatest }
}

function stated(text: string): Setup | undefined {
  const found = statedSetup(text)
  const model = found && modelKey(found.model)
  return model ? { model, effort: found.effort as Effort } : undefined
}

// Descriptions waiting for the question they belong to: $.ui.ask takes bare
// labels, so the tool.call hook below adds each row's reasoning to the dialog.
const pendingDescriptions = new Map<string, Record<string, string>>()

// Dismissed, or with no one to ask (-p), it keeps the setup.
async function ask($: $, d: Decision, v: Verdict, current: Setup, ctx: Parameters<typeof rows>[3]): Promise<Choice> {
  const options = rows(d, v, current, ctx)
  const question = questionText(d, v, ctx.limits)
  pendingDescriptions.set(question, Object.fromEntries(options.map(o => [o.label, o.description])))
  try {
    const answer = await $.ui.ask(question, { header: 'Model', options: options.map(o => o.label) })
    return options.find(o => o.label === answer)?.choice ?? 'keep'
  } catch {
    return 'keep'
  } finally {
    pendingDescriptions.delete(question)
  }
}

function recentTurns(rows: readonly SessionMessage[]): Turn[] {
  return rows.filter(m => m.text.trim()).slice(-6).map(m => ({ role: m.role, text: m.text }))
}

function limitsOf(rateLimits: readonly { kind: string; percentUsed: number }[]) {
  return {
    fiveHour: rateLimits.find(r => r.kind === 'five_hour')?.percentUsed,
    weekly: rateLimits.find(r => r.kind === 'seven_day')?.percentUsed,
  }
}

// The plugin's `about` setting, read when the module loads.
let about = ''

async function judge($: $, text: string, recent: Turn[], isFirstPrompt: boolean, contextTokens: number, timeoutMs: number) {
  const { value: previousTier } = await $.state.get(PREVIOUS_TIER)
  const started = Date.now()
  const r = await $.model.complete(
    judgeRequest(text, recent, { isFirstPrompt, contextTokens, previousTier: previousTier ?? undefined }, timeoutMs, about),
  )
  const verdict = r.isAnswered ? parseVerdict(r.text) : undefined
  if (!verdict) $.ui.log(`model-advisor: judge ${r.isAnswered ? 'reply unreadable' : r.reason}; left as is`, { to: 'debug' })
  return { verdict, ms: Date.now() - started, previousTier: previousTier ?? undefined }
}

function entry(v: Verdict, rest: Omit<LogEntry, 'at' | 'tier' | 'domain' | 'flags' | 'confidence' | 'continuation' | 'ongoing'>): LogEntry {
  return {
    at: new Date().toISOString(),
    tier: v.tier, domain: v.domain, flags: v.flags, confidence: v.confidence,
    continuation: v.continuation, ongoing: v.ongoing, ...rest,
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
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)
    if ((await $.state.get(IS_OFF)).value || isSkippable(e.text)) return next(e)

    const [rows, usage, { setup: current, isLatest }] = await Promise.all([
      $.session.messages() as Promise<SessionMessage[]>,
      $.session.usage(),
      currentSetup($),
    ])
    const isFirstPrompt = !rows.some(m => m.role === 'user' && m.text.trim())
    const contextTokens = isFirstPrompt ? 0 : usage.context.tokens ?? 0
    const { verdict, ms, previousTier } = await judge($, e.text, recentTurns(rows), isFirstPrompt, contextTokens, JUDGE_TIMEOUT_MS)
    if (!verdict) {
      if (isFirstPrompt) $.ui.toast('Model advisor: could not check this prompt, so it runs as set')
      return next(e)
    }

    const statedPick = stated(e.text)
    const limits = limitsOf(usage.rateLimits)
    const d = decide(verdict, {
      current, currentIsLatest: isLatest, stated: statedPick, isFirstPrompt, contextTokens, previousTier, limits,
    })
    const chosen: Choice = d.speak
      ? await ask($, d, verdict, current, { contextTokens, isFirstPrompt, limits, isStated: !!statedPick })
      : 'silent'
    const pick = chosen === 'best' ? d.best : chosen === 'balanced' ? d.balanced : undefined
    await $.state.set(PREVIOUS_TIER, d.tier)
    await appendLog($, entry(verdict, {
      kind: 'main', first: isFirstPrompt, contextK: Math.round(contextTokens / 1000), current: label(current),
      best: label(d.best), balanced: label(d.balanced), chosen, stated: !!statedPick, held: d.held, judgeMs: ms,
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

  // After /clear the next prompt is a fresh start, with nothing to continue.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await $.state.set(PREVIOUS_TIER, null)
    return next(e)
  })

  // Applies the sticky pick to every main request. A change the person makes
  // themselves (/model, effort) ends it.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const { value: active } = await $.state.get(ACTIVE)
    const effort = e.effort === undefined ? null : String(e.effort)
    if (!active) {
      if (effort && (await $.state.get(SEEN_EFFORT)).value !== effort) await $.state.set(SEEN_EFFORT, effort)
      return yield* next(e)
    }
    // The person set the picker to the pick itself: the override is no longer needed.
    if (e.model.startsWith(MODELS[active.model]) && effort === active.effort) {
      await $.state.set(ACTIVE, null)
      await showStatus($)
      return yield* next(e)
    }
    if (active.baseModel === null) {
      await $.state.set(ACTIVE, { ...active, baseModel: e.model, baseEffort: effort })
    } else if (active.baseModel !== e.model || active.baseEffort !== effort) {
      await $.state.set(ACTIVE, null)
      await showStatus($)
      $.ui.toast('Model advisor: you changed the model or effort, so its pick is cleared')
      return yield* next(e)
    }
    return yield* next({ ...e, model: MODELS[active.model], effort: active.effort })
  })

  // Subagents start fresh, so they are routed without a question.
  on('agent.spawn', async ($, e, next) => {
    if (e.fork || e.isTeammate || e.workflow || e.model !== undefined || !ROUTED_AGENTS.has(e.subagentType)) return next(e)
    if ((await $.state.get(IS_OFF)).value) return next(e)
    const parent = modelKey(e.parentModel) ?? 'opus'
    const { verdict, ms } = await judge($, e.prompt, [], true, 0, 5000)
    if (!verdict) return next(e)
    const pick = subagentModel(verdict, parent)
    await appendLog($, entry(verdict, {
      kind: 'subagent', first: true, contextK: 0, current: parent, best: pick,
      chosen: pick === parent ? 'kept' : 'routed', judgeMs: ms,
    }))
    return pick === parent ? next(e) : next({ ...e, model: MODELS[pick] })
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
      await $.state.set(ACTIVE, null)
      await showStatus($)
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
  const log = ((await $.store.get(LOG_KEY)) as LogEntry[] | undefined) ?? []
  if (log.length === 0) return 'No picks logged yet.'
  const main = log.filter(x => x.kind === 'main')
  const count = (c: string) => main.filter(x => x.chosen === c).length
  const asked = main.length - count('silent')
  const lines = log.slice(-15).map(x => {
    const when = x.at.slice(5, 16).replace('T', ' ')
    const what = `${x.tier}/${x.domain}${x.continuation ? ' (continues)' : ''}`
    const pick = x.kind === 'subagent'
      ? `subagent ${x.current} -> ${x.best} (${x.chosen})`
      : x.chosen === 'silent'
        ? `on ${x.current}, silent`
        : `on ${x.current}; Best ${x.best}, Balanced ${x.balanced}; chose ${x.chosen}`
    return `${when}  ${what.padEnd(22)} ${pick}`
  })
  return [
    `${main.length} prompts judged, asked on ${asked}: Best ${count('best')}, Balanced ${count('balanced')}, Keep ${count('keep')}. ` +
      `${log.length - main.length} subagents judged, ${log.filter(x => x.chosen === 'routed').length} routed.`,
    ...lines,
  ].join('\n')
}
