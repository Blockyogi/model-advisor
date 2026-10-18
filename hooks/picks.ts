// Turns the judge's facts into a tier, and the tier into Best and Balanced. All
// rules live here, in code: the tier table, never-route-down, continuations,
// the lopsided rule, two runs before a move down, plan limits, and the
// two-prompt rule for mid-session model switches.

import type { Domain, Flag, Tier, Verdict } from './judge'

export const MODELS = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
} as const
export type ModelKey = keyof typeof MODELS

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

export type Setup = { model: ModelKey; effort: Effort }

export type Limits = { fiveHour?: number; weekly?: number }

export type PickContext = {
  current: Setup
  // false when the session runs an older generation (claude-opus-5): the
  // same family's 5.5 model then counts as a change
  currentIsLatest?: boolean
  // model and effort the prompt itself names
  stated?: Setup
  isFirstPrompt: boolean
  contextTokens: number
  previousTier?: Tier
  limits: Limits
}

export type Decision = {
  tier: Tier
  neverDown: boolean
  best: Setup
  balanced: Setup
  speak: boolean
  why: string
  // what stopped a change, for the log
  held?: string
}

const NAMES: Record<ModelKey, string> = { haiku: 'Haiku 5.5', sonnet: 'Sonnet 5.5', opus: 'Opus 5.5', fable: 'Fable 5.1' }

export function label(s: Setup): string {
  return `${NAMES[s.model]} · ${s.effort}`
}

export function modelKey(id: string): ModelKey | undefined {
  const lower = id.toLowerCase()
  return (Object.keys(MODELS) as ModelKey[]).find(k => lower.includes(k))
}

// Relative weight on plan limits. Model weights follow list prices; effort
// weights follow Opus 5.5's cost per Terminal-Bench attempt (medium = 1).
const MODEL_WEIGHT: Record<ModelKey, number> = { haiku: 0.05, sonnet: 0.5, opus: 1, fable: 2.5 }
const EFFORT_WEIGHT: Record<Effort, number> = { low: 0.45, medium: 1, high: 1.3, xhigh: 2.5, max: 3.8 }
export const weight = (s: Setup) => MODEL_WEIGHT[s.model] * EFFORT_WEIGHT[s.effort]

const TIER_RANK: Record<Tier, number> = { light: 0, standard: 1, deep: 2, frontier: 3 }
const same = (a: Setup, b: Setup) => a.model === b.model && a.effort === b.effort
const s = (model: ModelKey, effort: Effort): Setup => ({ model, effort })

// The tier the facts call for (v2 plan 4.1), from the definitions the phase 3
// labels used: light is looking something up or one act already decided;
// standard is a few steps along a known pattern, edits as specified, or a draft
// for review; deep is many files or sources, new ground, a result not checkable
// at a glance, an unknown cause, a failed attempt, numbers that must tie out,
// or a legal or tender text for an outside party. Frontier is a failed attempt
// at work already rated deep: the judge cannot count attempts reliably (it saw
// "failed twice" in 3 dev prompts, wrongly each time), so the session's own
// tier is the evidence. Stakes (production, money, irreversible) never raise
// the tier: never-route-down keeps such work from moving down instead.
// outside_audience and relied_on alone did not track the labels well enough
// to raise it (section 11 of the v2 plan).
const HARDER: readonly Flag[] = ['unknown_cause', 'failed_before', 'must_reconcile']

export function tierOf(v: Verdict, previousTier?: Tier): Tier {
  const has = (f: Flag) => v.flags.includes(f)
  const many = v.scope === 'many'
  // Looking something up, or one known act, is light; many separate acts are a job.
  if (v.action === 'ship' || v.action === 'lookup') return many || has('unknown_cause') || has('must_reconcile') ? 'standard' : 'light'
  const legalText = (v.domain === 'legal' || v.domain === 'tender') && has('outside_audience') &&
    (v.action === 'draft' || v.action === 'edit' || v.action === 'answer' || v.action === 'plan')
  // Many edits made as specified (sorting folders, an inbox clean-up) stay a known job.
  const harder = (many && v.action !== 'edit') || !v.checkable || v.novelty === 'new' || HARDER.some(has) || legalText
  if (!harder) return 'standard'
  const deepBefore = previousTier === 'deep' || previousTier === 'frontier'
  return has('failed_before') && deepBefore ? 'frontier' : 'deep'
}

// Section 4 of the v1 research and section 4.7 of the v2 plan.
function table(tier: Tier, domain: Domain, v: Verdict, current: Setup): { best: Setup; balanced: Setup } {
  switch (tier) {
    case 'light':
      // Haiku was offered 34 times as a main-session Best and never taken; it stays for subagents.
      return { best: s('sonnet', 'low'), balanced: s('sonnet', 'low') }
    case 'standard':
      // Opus leads WebDev Arena and the big website benchmarks sit within 2 points; Sonnet codes at high, not medium.
      if (domain === 'website') return { best: s('opus', 'medium'), balanced: s('sonnet', 'high') }
      if (domain === 'spreadsheet') return { best: s('sonnet', 'high'), balanced: s('sonnet', 'medium') }
      if (domain === 'copy') return { best: s('opus', 'medium'), balanced: s('opus', 'medium') }
      return { best: s('opus', 'medium'), balanced: domain === 'ios' || domain === 'code' ? s('opus', 'low') : s('sonnet', 'medium') }
    case 'deep':
      if (domain === 'copy') return { best: s('opus', 'medium'), balanced: s('opus', 'medium') }
      if (v.flags.includes('unknown_cause') && (domain === 'code' || domain === 'ios' || domain === 'website'))
        return { best: s('opus', 'xhigh'), balanced: s('opus', 'high') }
      return { best: s('opus', 'high'), balanced: s('opus', 'medium') }
    case 'frontier': {
      // Fable only once Opus at xhigh has also fallen short (Opus 5.5 medium
      // matched Fable 5.1 high on SWE-bench Pro), and never for research.
      const onTopSetup = current.model === 'fable' || (current.model === 'opus' && (current.effort === 'xhigh' || current.effort === 'max'))
      if (domain !== 'research' && v.flags.includes('failed_before') && onTopSetup) return { best: s('fable', 'high'), balanced: s('opus', 'xhigh') }
      return { best: s('opus', 'xhigh'), balanced: s('opus', 'high') }
    }
  }
}

// Mechanical work (install, push, rename, a known command, sending approved
// text) needs care, not a stronger model. A go-ahead or status reply is
// mechanical only when the step it resumes is: its action is that step's.
export function isMechanical(v: Verdict): boolean {
  return v.action === 'ship' && v.scope !== 'many' && !v.flags.some(f => f === 'unknown_cause' || f === 'failed_before')
}

export function isNeverDown(v: Verdict, tier: Tier): boolean {
  if (v.risky) return true
  if (v.domain === 'legal' || v.domain === 'tender') return true
  if (v.flags.some(f => f === 'production' || f === 'money' || f === 'irreversible' || f === 'failed_before')) return true
  // Public text: copy is public by its definition, and a website change is when the public reads what it changes.
  if (v.domain === 'copy' && v.action !== 'lookup') return true
  if (v.domain === 'website' && v.flags.includes('outside_audience')) return true
  if ((v.domain === 'ledger' || v.domain === 'finance') && tier !== 'light' && v.flags.some(f => f === 'must_reconcile' || f === 'relied_on')) return true
  return false
}

// One notch cheaper: effort first, then model.
function cheaper(x: Setup): Setup {
  const i = EFFORTS.indexOf(x.effort)
  if (i > 0) return { ...x, effort: EFFORTS[i - 1] ?? 'low' }
  if (x.model === 'fable') return s('opus', 'high')
  if (x.model === 'opus') return s('sonnet', 'medium')
  return x
}

function atLeast(x: Setup, floor: Setup): Setup {
  return weight(x) >= weight(floor) ? x : floor
}

// Down means a lower model family or less usage: Opus low to Sonnet medium is down.
const below = (x: Setup, y: Setup) => MODEL_WEIGHT[x.model] < MODEL_WEIGHT[y.model] || weight(x) < weight(y)

const effortNotchDown = (x: Setup): Setup => ({ ...x, effort: EFFORTS[Math.max(0, EFFORTS.indexOf(x.effort) - 1)] ?? 'low' })

// Re-read cost of a model switch against what the cheaper model saves over
// two prompts (about 33 requests each), in dollars at list prices.
const CACHE_WRITE: Record<ModelKey, number> = { haiku: 0.125, sonnet: 2.5, opus: 5, fable: 12.5 }
const CACHE_READ: Record<ModelKey, number> = { haiku: 0.01, sonnet: 0.1, opus: 0.2, fable: 0.25 }
const OUTPUT: Record<ModelKey, number> = { haiku: 0.5, sonnet: 10, opus: 20, fable: 50 }
const REQUESTS_PER_PROMPT = 33
const OUTPUT_PER_REQUEST = 600

export function switchCost(from: ModelKey, to: ModelKey, contextTokens: number) {
  const reread = (contextTokens / 1e6) * CACHE_WRITE[to]
  const perRequest =
    (contextTokens / 1e6) * (CACHE_READ[from] - CACHE_READ[to]) + (OUTPUT_PER_REQUEST / 1e6) * (OUTPUT[from] - OUTPUT[to])
  return { reread, savedOverTwoPrompts: perRequest * REQUESTS_PER_PROMPT * 2 }
}

// A mid-session move to a cheaper model must pay back its re-read within two
// prompts and the work must be ongoing; otherwise keep the model, change effort.
function keepModelIfSwitchDoesNotPay(pick: Setup, ctx: PickContext, v: Verdict, tier: Tier): Setup {
  if (ctx.isFirstPrompt || pick.model === ctx.current.model) return pick
  const cheaperModel = MODEL_WEIGHT[pick.model] < MODEL_WEIGHT[ctx.current.model]
  if (!cheaperModel) return pick // moving up is for quality; it is always allowed
  const { reread, savedOverTwoPrompts } = switchCost(ctx.current.model, pick.model, ctx.contextTokens)
  if (v.ongoing && savedOverTwoPrompts > reread) return pick
  // Same model, effort no higher than the pick asked for at its own weight.
  const effort = [...EFFORTS].reverse().find(e => weight(s(ctx.current.model, e)) <= weight(pick) * 1.5) ?? 'low'
  if (TIER_RANK[tier] < TIER_RANK.deep) return s(ctx.current.model, effort)
  // Deep work keeps at least the table's effort, and never below medium: Fable
  // low is no stand-in for Opus high.
  const floor = Math.max(EFFORTS.indexOf(effort), EFFORTS.indexOf(pick.effort), EFFORTS.indexOf('medium'))
  return s(ctx.current.model, EFFORTS[floor] ?? pick.effort)
}

// Subagents are routed by what they are and the job they are given, with no
// judge call (v2 plan, section 4.6). Types left out here keep their own
// definition: design-critic runs on Fable, claude-code-guide on Haiku, Plan
// and the editing agents inherit.
export type SubagentJob = 'search' | 'review' | 'work'
const TYPE_JOBS: Record<string, SubagentJob> = {
  Explore: 'search',
  'copy-reviewer': 'review',
  'impeccable-finish-reviewer': 'review',
}
// Types with no job of their own, which the brief decides.
const BRIEFED_TYPES = new Set(['general-purpose', 'claude'])

// A brief frames its job in its opening: "Research task, read-only", "Work
// read-only in ...", "STRICTLY READ-ONLY". "Do not edit" alone is no sign:
// writers and editors say it of the files they must leave alone.
const READ_ONLY = /\bread-only\b/i
const FRAMING_CHARS = 1000
// A reviewer's brief opens by naming the reviewer it acts as, or as a read-only review or audit.
const ACTS_AS_REVIEWER = /copy-reviewer|finish[- ]reviewer/i
const REVIEW = /\b(?:review|reviewer|reviewing|audit|auditing|critique)\b/i
const OPENING_CHARS = 300

export function subagentJob(type: string, prompt: string): SubagentJob | undefined {
  const own = TYPE_JOBS[type]
  if (own || !BRIEFED_TYPES.has(type)) return own
  const opening = prompt.slice(0, OPENING_CHARS)
  const readOnly = READ_ONLY.test(prompt.slice(0, FRAMING_CHARS))
  if (ACTS_AS_REVIEWER.test(opening) || (readOnly && REVIEW.test(opening))) return 'review'
  return readOnly ? 'search' : 'work'
}

// Searches go to Haiku 5.5 medium, reviews to Sonnet 5.5 high (Haiku skips
// checks, and reviews exist to check), work keeps the parent's model at medium.
// Inside a never-route-down task every job keeps the parent's setup. `parent`
// is the advisor's pick the main loop runs; without one the subagent already
// inherits what its parent runs, so only what changes is set.
export function subagentRoute(job: SubagentJob, parent: Setup | undefined, inNeverDownTask: boolean): Partial<Setup> {
  if (inNeverDownTask) return parent ? { ...parent } : {}
  if (job === 'search') return s('haiku', 'medium')
  if (job === 'review') return s('sonnet', 'high')
  return parent ? { model: parent.model, effort: 'medium' } : { effort: 'medium' }
}

export function decide(verdict: Verdict, ctx: PickContext): Decision {
  // A first prompt continues nothing in this session.
  const v = ctx.isFirstPrompt ? { ...verdict, continuation: false } : verdict
  const mechanical = isMechanical(v)
  let tier = tierOf(v, ctx.previousTier)
  // A go-ahead or status reply resumes real work unless its step is mechanical
  // (push it, send it): at least standard, and the tier of the work it resumes.
  if (v.continuation && !mechanical) {
    if (tier === 'light') tier = 'standard'
    if (ctx.previousTier && TIER_RANK[ctx.previousTier] > TIER_RANK[tier]) tier = ctx.previousTier
  }
  const neverDown = isNeverDown(v, tier) || (v.continuation && (tier === 'deep' || tier === 'frontier'))

  let { best, balanced } = table(tier, v.domain, v, ctx.current)
  // Never-route-down work that needs thought runs on Opus 5.5 at medium or above,
  // whatever its tier: the stakes set a floor, they do not make the work harder.
  if (neverDown && !mechanical) best = atLeast(best, s('opus', 'medium'))

  // Risky acts run on Opus 5.5 at high or above.
  if (v.risky && !mechanical) {
    best = atLeast(best, s('opus', 'high'))
    if (best.model !== 'opus' && best.model !== 'fable') best = s('opus', 'high')
  }
  if (neverDown) balanced = best

  // Plan limits: Balanced steps one notch cheaper when the week or the 5 hours run low.
  const tight = (ctx.limits.weekly ?? 0) >= 80 || (ctx.limits.fiveHour ?? 0) >= 85
  if (tight && !neverDown) balanced = cheaper(balanced)

  // Two-prompt rule for mid-session switches to a cheaper model.
  best = keepModelIfSwitchDoesNotPay(best, ctx, v, tier)
  balanced = keepModelIfSwitchDoesNotPay(balanced, ctx, v, tier)

  // In a big conversation on Opus, Balanced prefers Opus at low effort over a
  // move to Sonnet: about the same usage, no re-read (effort keeps the cache).
  if (!ctx.isFirstPrompt && ctx.contextTokens >= 100_000 && ctx.current.model === 'opus' && balanced.model === 'sonnet')
    balanced = s('opus', 'low')

  // Lopsided rule: neither pick drops below the current setup for
  // never-route-down work or a continuation; elsewhere a move down needs a
  // second judge run that agrees (agree() below).
  // Mid-session, a one-off aside never moves the session down: the choice
  // sticks, so the work after it would inherit the cheaper setup.
  let held: string | undefined
  const hold = (why: string) => {
    if (below(best, ctx.current)) (best = ctx.current), (held = why)
    if (below(balanced, ctx.current)) (balanced = ctx.current), (held = why)
  }
  if (neverDown || v.continuation) hold(neverDown ? 'never routed down' : 'it continues the work in progress')
  if (!ctx.isFirstPrompt && !v.ongoing) hold('one-off aside')
  // A light request inside heavier work is an aside, whatever the judge says of it.
  if (!ctx.isFirstPrompt && tier === 'light' && ctx.previousTier !== 'light') hold('light aside in heavier work')
  if (weight(balanced) > weight(best)) balanced = best

  // The prompt's own model and effort win: it was decided when it was written.
  // A setup the prompt names becomes Best; the advisor's own pick stays as
  // Balanced when it is lighter, so a heavy plan choice can still be declined.
  const why = v.work
  if (ctx.stated) {
    const own = best
    best = ctx.stated
    balanced = weight(own) < weight(ctx.stated) ? own : ctx.stated
  }

  return { tier, neverDown, best, balanced, speak: speaks(best, balanced, v, tier, ctx), why, held }
}

// Speak only when a change would help: any move up, a model change, or an
// effort-only move down that saves at least 40%. Smaller savings are not worth a question.
// A same-model effort step up under 1.5x (Opus medium to high) is not worth a
// question, except for never-route-down or risky work, and on Sonnet, which
// gains far more from medium to high.
// A continuation of plain deep work is not on that list: it stays as quiet as the work it continues.
function speaks(best: Setup, balanced: Setup, v: Verdict, tier: Tier, ctx: PickContext): boolean {
  const smallStepUp = (pick: Setup) =>
    !isNeverDown(v, tier) && pick.model === 'opus' &&
    pick.model === ctx.current.model && weight(pick) > weight(ctx.current) && weight(pick) / weight(ctx.current) < 1.5
  const helps = (pick: Setup) =>
    !(same(pick, ctx.current) && ctx.currentIsLatest !== false) &&
    !(smallStepUp(pick) && ctx.currentIsLatest !== false) &&
    (weight(pick) > weight(ctx.current) ||
      pick.model !== ctx.current.model ||
      ctx.currentIsLatest === false ||
      1 - weight(pick) / weight(ctx.current) >= 0.4)
  return helps(best) || helps(balanced)
}

// Haiku's stated confidence carries no information (it said "low" once in 393
// verdicts), so a move down needs a second judge run instead (v2 plan 4.5).
// Only a prompt with no setup of its own is checked: a named setup is the person's call.
export const movesDown = (d: Decision, ctx: PickContext) => !ctx.stated && (below(d.best, ctx.current) || below(d.balanced, ctx.current))

export const DISAGREE = 'the two runs disagree'

// A pick below the current setup stands only when the second run also goes
// below it; where both do, the higher of the two stands. With plan limits
// tight, Balanced may still go one effort notch lower when the runs disagree,
// unless either run calls the work never-route-down.
export function agree(first: Decision, second: Decision | undefined, v: Verdict, ctx: PickContext): Decision {
  const tight = (ctx.limits.weekly ?? 0) >= 80 || (ctx.limits.fiveHour ?? 0) >= 85
  const neverDown = first.neverDown || second?.neverDown === true
  let held = first.held
  const settle = (pick: Setup, other: Setup | undefined, floor: Setup): Setup => {
    if (!below(pick, ctx.current)) return pick
    if (other && below(other, ctx.current)) return below(pick, other) ? other : pick
    held = DISAGREE
    return below(pick, floor) ? floor : pick
  }
  const best = settle(first.best, second?.best, ctx.current)
  let balanced = settle(first.balanced, second?.balanced, tight && !neverDown ? effortNotchDown(ctx.current) : ctx.current)
  if (weight(balanced) > weight(best)) balanced = best
  return { ...first, neverDown, best, balanced, held, speak: speaks(best, balanced, v, first.tier, ctx) }
}
