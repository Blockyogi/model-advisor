// Turns the judge's verdict into Best and Balanced. All safety rules live here,
// in code: never-route-down, continuations, the lopsided rule, Haiku over 100K,
// plan limits, and the two-prompt rule for mid-session model switches.

import type { Domain, Tier, Verdict } from './judge'

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

// Section 4 and the section 3 task map of the research document.
function table(tier: Tier, domain: Domain, v: Verdict, isFirstPrompt: boolean): { best: Setup; balanced: Setup } {
  const leansSonnet = domain === 'website' || domain === 'spreadsheet'
  switch (tier) {
    case 'light':
      return isFirstPrompt
        ? { best: s('haiku', 'medium'), balanced: s('haiku', 'low') }
        : { best: s('sonnet', 'low'), balanced: s('haiku', 'low') }
    case 'standard':
      if (leansSonnet) return { best: s('sonnet', 'high'), balanced: s('sonnet', 'medium') }
      if (domain === 'copy') return { best: s('opus', 'medium'), balanced: s('opus', 'medium') }
      return { best: s('opus', 'medium'), balanced: domain === 'ios' || domain === 'code' ? s('opus', 'low') : s('sonnet', 'medium') }
    case 'deep':
      if (domain === 'copy') return { best: s('opus', 'medium'), balanced: s('opus', 'medium') }
      if (v.flags.includes('unknown_cause') && (domain === 'code' || domain === 'ios' || domain === 'website'))
        return { best: s('opus', 'xhigh'), balanced: s('opus', 'high') }
      return { best: s('opus', 'high'), balanced: s('opus', 'medium') }
    case 'frontier':
      // Fable only once Opus has fallen short (Anthropic's guidance); never for research.
      if (domain === 'research' || !v.flags.includes('failed_before')) return { best: s('opus', 'xhigh'), balanced: s('opus', 'high') }
      return { best: s('fable', 'high'), balanced: s('opus', 'xhigh') }
  }
}

export function isNeverDown(v: Verdict, tier: Tier): boolean {
  if (v.risky) return true
  if (v.domain === 'legal' || v.domain === 'tender') return true
  if (v.flags.some(f => f === 'production' || f === 'money' || f === 'irreversible' || f === 'failed_before')) return true
  if (v.domain === 'copy' && v.flags.includes('outside_audience')) return true
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
function keepModelIfSwitchDoesNotPay(pick: Setup, ctx: PickContext, v: Verdict): Setup {
  if (ctx.isFirstPrompt || pick.model === ctx.current.model) return pick
  const cheaperModel = MODEL_WEIGHT[pick.model] < MODEL_WEIGHT[ctx.current.model]
  if (!cheaperModel) return pick // moving up is for quality; it is always allowed
  const { reread, savedOverTwoPrompts } = switchCost(ctx.current.model, pick.model, ctx.contextTokens)
  if (v.ongoing && savedOverTwoPrompts > reread) return pick
  // Same model, effort no higher than the pick asked for at its own weight.
  const effort = [...EFFORTS].reverse().find(e => weight(s(ctx.current.model, e)) <= weight(pick) * 1.5) ?? 'low'
  return s(ctx.current.model, effort)
}

// Subagents start fresh (no cache to lose), so they are routed without a
// question; down from the parent's model only when the judge is sure.
export function subagentModel(v: Verdict, parent: ModelKey): ModelKey {
  const tier = v.tier === 'light' && v.flags.length > 0 ? 'standard' : v.tier
  const pick: ModelKey =
    v.mechanical && !v.risky ? 'haiku'
    : tier === 'light' ? 'haiku'
    : tier === 'standard' ? (v.domain === 'code' || v.domain === 'ios' ? 'opus' : 'sonnet')
    : 'opus'
  const down = MODEL_WEIGHT[pick] < MODEL_WEIGHT[parent]
  if (down && (v.confidence !== 'high' || isNeverDown(v, tier))) return parent
  return pick
}

export function decide(verdict: Verdict, ctx: PickContext): Decision {
  // A first prompt continues nothing in this session.
  const v = ctx.isFirstPrompt ? { ...verdict, continuation: false } : verdict
  let tier = v.tier
  // Frontier needs evidence: an earlier attempt failed, or many sources.
  if (tier === 'frontier' && !v.flags.some(f => f === 'failed_before' || f === 'many_sources')) tier = 'deep'
  // Mechanical work (install, push, rename, a known command) needs care, not a
  // stronger model: it is light, and never-route-down below keeps a risky act where it is.
  if (v.mechanical) tier = 'light'
  // Continuations inherit the tier of the work and are never routed down.
  if (v.continuation && !v.mechanical && ctx.previousTier && TIER_RANK[ctx.previousTier] > TIER_RANK[tier]) tier = ctx.previousTier
  // Any up-flag lifts a light verdict.
  if (tier === 'light' && v.flags.length > 0 && !v.mechanical) tier = 'standard'
  const neverDown = isNeverDown(v, tier) || (v.continuation && (tier === 'deep' || tier === 'frontier'))
  if (neverDown && tier === 'light' && !v.mechanical) tier = 'standard'

  let { best, balanced } = table(tier, v.domain, v, ctx.isFirstPrompt)

  // Risky acts run on Opus 5.5 at high or above.
  if (v.risky && !v.mechanical) {
    best = atLeast(best, s('opus', 'high'))
    if (best.model !== 'opus' && best.model !== 'fable') best = s('opus', 'high')
  }
  if (neverDown) balanced = best

  // Plan limits: Balanced steps one notch cheaper when the week or the 5 hours run low.
  const tight = (ctx.limits.weekly ?? 0) >= 80 || (ctx.limits.fiveHour ?? 0) >= 85
  if (tight && !neverDown) balanced = cheaper(balanced)

  // Haiku never takes a conversation over 100K tokens.
  const big = ctx.contextTokens > 100_000
  if (big) {
    if (best.model === 'haiku') best = s('sonnet', 'low')
    if (balanced.model === 'haiku') balanced = s('sonnet', 'low')
  }

  // Two-prompt rule for mid-session switches to a cheaper model.
  best = keepModelIfSwitchDoesNotPay(best, ctx, v)
  balanced = keepModelIfSwitchDoesNotPay(balanced, ctx, v)

  // In a big conversation on Opus, Balanced prefers Opus at low effort over a
  // move to Sonnet: about the same usage, no re-read (effort keeps the cache).
  if (!ctx.isFirstPrompt && ctx.contextTokens >= 100_000 && ctx.current.model === 'opus' && balanced.model === 'sonnet')
    balanced = s('opus', 'low')

  // Lopsided rule: neither pick drops below the current setup unless the judge
  // is sure, and never for never-route-down work.
  // Mid-session, a one-off aside never moves the session down: the choice
  // sticks, so the work after it would inherit the cheaper setup.
  let held: string | undefined
  const hold = (why: string) => {
    if (weight(best) < weight(ctx.current)) (best = ctx.current), (held = why)
    if (weight(balanced) < weight(ctx.current)) (balanced = ctx.current), (held = why)
  }
  if (v.confidence !== 'high' || neverDown || v.continuation) hold('not sure enough to go lower')
  if (!ctx.isFirstPrompt && !v.ongoing) hold('one-off aside')
  // A light request inside heavier work is an aside, whatever the judge says of it.
  if (!ctx.isFirstPrompt && tier === 'light' && ctx.previousTier !== 'light') hold('light aside in heavier work')
  if (weight(balanced) > weight(best)) balanced = best

  // The prompt's own model and effort win: it was decided when it was written.
  // A setup the prompt names becomes Best; the advisor's own pick stays as
  // Balanced when it is lighter, so a heavy plan choice can still be declined.
  const why = v.why
  if (ctx.stated) {
    const own = best
    best = ctx.stated
    balanced = weight(own) < weight(ctx.stated) ? own : ctx.stated
  }

  // Speak only when a change would help: any move up, a model change, or an
  // effort-only move down that saves at least 40%. Smaller savings are not worth a question.
  // A same-model effort step up under 1.5x (medium to high) is not worth a question.
  const smallStepUp = (pick: Setup) =>
    pick.model === ctx.current.model && weight(pick) > weight(ctx.current) && weight(pick) / weight(ctx.current) < 1.5
  const helps = (pick: Setup) =>
    !(same(pick, ctx.current) && ctx.currentIsLatest !== false) &&
    !(smallStepUp(pick) && ctx.currentIsLatest !== false) &&
    (weight(pick) > weight(ctx.current) ||
      pick.model !== ctx.current.model ||
      ctx.currentIsLatest === false ||
      1 - weight(pick) / weight(ctx.current) >= 0.4)
  return { tier, neverDown, best, balanced, speak: helps(best) || helps(balanced), why, held }
}
