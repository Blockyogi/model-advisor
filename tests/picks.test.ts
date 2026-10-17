import { describe, expect, test } from 'claude-code/testing'
import { isSkippable, parseVerdict, statedSetup, type Verdict } from '../hooks/judge'
import { decide, label, subagentModel, weight, type PickContext } from '../hooks/picks'
import { questionText, rows } from '../hooks/reasons'

const verdict = (v: Partial<Verdict>): Verdict => ({
  tier: 'standard', domain: 'code', flags: [], risky: false, mechanical: false, continuation: false,
  ongoing: true, confidence: 'medium', why: '', ...v,
})
const mid = (c: Partial<PickContext> = {}): PickContext => ({
  current: { model: 'opus', effort: 'medium' }, isFirstPrompt: false, contextTokens: 200_000, limits: {}, ...c,
})
const first = (c: Partial<PickContext> = {}): PickContext => mid({ isFirstPrompt: true, contextTokens: 0, ...c })

describe('the six replay cases from the plan', () => {
  test('a rename mid-session is light and silent', () => {
    const d = decide(verdict({ tier: 'light', domain: 'admin', confidence: 'high', ongoing: false }), mid())
    expect(d.speak).toBe(false)
  })

  test('a legal notice is deep and never routed down', () => {
    const v = verdict({ tier: 'deep', domain: 'legal', flags: ['outside_audience'], confidence: 'high' })
    const fromSonnet = decide(v, first({ current: { model: 'sonnet', effort: 'medium' } }))
    expect(fromSonnet.neverDown).toBe(true)
    expect(label(fromSonnet.best)).toBe('Opus 5.5 · high')
    expect(label(fromSonnet.balanced)).toBe('Opus 5.5 · high')
    const fromFable = decide(v, mid({ current: { model: 'fable', effort: 'high' } }))
    expect(fromFable.speak).toBe(false)
  })

  test('running the production migration is risky: Opus 5.5 at high', () => {
    const v = verdict({ tier: 'standard', risky: true, flags: ['production', 'irreversible'], confidence: 'high' })
    const d = decide(v, first({ current: { model: 'sonnet', effort: 'medium' } }))
    expect(d.best.model).toBe('opus')
    expect(weight(d.best)).toBeGreaterThanOrEqual(weight({ model: 'opus', effort: 'high' }))
    expect(d.balanced).toEqual(d.best)
  })

  test('"ok do it" after a design discussion keeps the setup; a longer one inherits deep', () => {
    expect(isSkippable('ok do it')).toBe(true)
    const v = verdict({ tier: 'light', continuation: true, confidence: 'high' })
    const d = decide(v, mid({ previousTier: 'deep', current: { model: 'opus', effort: 'high' } }))
    expect(d.tier).toBe('deep')
    expect(d.neverDown).toBe(true)
    expect(d.speak).toBe(false)
  })

  test('a Next.js form at session start goes to Sonnet 5.5 at high', () => {
    const d = decide(verdict({ domain: 'website', confidence: 'high' }), first())
    expect(label(d.best)).toBe('Sonnet 5.5 · high')
    expect(label(d.balanced)).toBe('Sonnet 5.5 · medium')
    expect(d.speak).toBe(true)
  })

  test('a 300K conversation on Opus prefers an effort change for Balanced', () => {
    const d = decide(verdict({ domain: 'website', confidence: 'high' }), mid({ contextTokens: 300_000, current: { model: 'opus', effort: 'high' } }))
    expect(label(d.balanced)).toBe('Opus 5.5 · low')
  })
})

describe('the other rules', () => {
  test('weekly usage at 80% makes Balanced cheaper', () => {
    const v = verdict({ tier: 'deep', confidence: 'high' })
    const relaxed = decide(v, first({ current: { model: 'opus', effort: 'high' } }))
    const tight = decide(v, first({ current: { model: 'opus', effort: 'high' }, limits: { weekly: 80 } }))
    expect(weight(tight.balanced)).toBeLessThan(weight(relaxed.balanced))
  })

  test('two-prompt rule: a one-off aside never moves the session down', () => {
    const d = decide(verdict({ domain: 'website', confidence: 'high', ongoing: false }), mid({ current: { model: 'opus', effort: 'high' } }))
    expect(weight(d.best)).toBeGreaterThanOrEqual(weight({ model: 'opus', effort: 'high' }))
    expect(weight(d.balanced)).toBeGreaterThanOrEqual(weight({ model: 'opus', effort: 'high' }))
  })

  test('not sure enough: no move down without high confidence', () => {
    const d = decide(verdict({ domain: 'website', confidence: 'medium' }), first({ current: { model: 'opus', effort: 'high' } }))
    expect(d.speak).toBe(false)
  })

  test('Haiku never takes a conversation over 100K', () => {
    const d = decide(verdict({ tier: 'light', domain: 'admin', confidence: 'high' }), mid({ contextTokens: 150_000, previousTier: 'light' }))
    expect(d.best.model).not.toBe('haiku')
    expect(d.balanced.model).not.toBe('haiku')
  })

  test('a prompt that names its model and effort gets them', () => {
    const named = statedSetup('Build R34 Pass 9. Model per R34 §3: Sonnet 5.5 at medium.')
    expect(named).toEqual({ model: 'sonnet', effort: 'medium' })
    const d = decide(verdict({ tier: 'deep' }), first({ stated: { model: 'sonnet', effort: 'medium' } }))
    expect(label(d.best)).toBe('Sonnet 5.5 · medium')
  })

  test('an older-generation session is offered the current one', () => {
    const d = decide(verdict({ tier: 'deep', confidence: 'high' }), first({ current: { model: 'opus', effort: 'high' }, currentIsLatest: false }))
    expect(d.speak).toBe(true)
  })

  test('subagents: light work goes to Haiku only when the judge is sure', () => {
    expect(subagentModel(verdict({ tier: 'light', domain: 'admin', confidence: 'high' }), 'opus')).toBe('haiku')
    expect(subagentModel(verdict({ tier: 'light', domain: 'admin', confidence: 'medium' }), 'opus')).toBe('opus')
    expect(subagentModel(verdict({ tier: 'deep', domain: 'legal', confidence: 'high' }), 'sonnet')).toBe('opus')
  })

  test('the judge reply is read leniently and refused when broken', () => {
    expect(parseVerdict('Sure: {"tier":"deep","domain":"legal","flags":["money","bogus"],"confidence":"high"} done')?.flags).toEqual(['money'])
    expect(parseVerdict('{"tier":"standard","domain":"copy","why":"one draft","}')?.tier).toBe('standard')
    expect(parseVerdict('{"tier":"huge"}')).toBe(undefined)
    expect(parseVerdict('no json')).toBe(undefined)
  })
})

describe('mechanical and risky acts', () => {
  test('installing a build on the device mid-session stays silent on Sonnet medium', () => {
    const v = verdict({ tier: 'standard', domain: 'ios', mechanical: true, flags: ['production'], risky: true, confidence: 'medium' })
    const d = decide(v, mid({ current: { model: 'sonnet', effort: 'medium' } }))
    expect(d.speak).toBe(false)
  })

  test('pushing to main is never sent to Fable, and never down', () => {
    const v = verdict({ tier: 'frontier', mechanical: true, flags: ['production', 'irreversible', 'relied_on'], risky: true, continuation: true })
    const d = decide(v, mid({ current: { model: 'sonnet', effort: 'medium' }, previousTier: 'deep' }))
    expect(d.best.model).not.toBe('fable')
    expect(d.speak).toBe(false)
    expect(weight(d.balanced)).toBeGreaterThanOrEqual(weight({ model: 'sonnet', effort: 'medium' }))
  })

  test('frontier without a failed attempt or many sources is treated as deep', () => {
    const d = decide(verdict({ tier: 'frontier', confidence: 'high' }), first())
    expect(d.tier).toBe('deep')
    expect(d.best.model).toBe('opus')
  })

  test('Fable is offered only after a failed attempt', () => {
    const planned = decide(verdict({ tier: 'frontier', flags: ['many_sources'], confidence: 'high' }), first())
    expect(label(planned.best)).toBe('Opus 5.5 · xhigh')
    const failed = decide(verdict({ tier: 'frontier', flags: ['failed_before', 'many_sources'], confidence: 'high' }), first())
    expect(failed.best.model).toBe('fable')
  })

  test('a risky act that needs thought still goes to Opus at high', () => {
    const d = decide(verdict({ risky: true, flags: ['production'], confidence: 'high' }), first({ current: { model: 'sonnet', effort: 'medium' } }))
    expect(label(d.best)).toBe('Opus 5.5 · high')
  })
})

describe('noise', () => {
  test('a small effort step up on the same model stays silent', () => {
    const d = decide(verdict({ tier: 'deep', domain: 'code', confidence: 'medium' }), mid({ current: { model: 'opus', effort: 'medium' } }))
    expect(label(d.best)).toBe('Opus 5.5 · high')
    expect(d.speak).toBe(false)
  })

  test('legal, tender and risky work on Opus medium still asks for high', () => {
    for (const v of [
      verdict({ tier: 'deep', domain: 'legal', flags: ['outside_audience'], confidence: 'high' }),
      verdict({ tier: 'deep', domain: 'tender', confidence: 'medium' }),
      verdict({ risky: true, flags: ['production'], confidence: 'high' }),
    ]) {
      const d = decide(v, mid({ current: { model: 'opus', effort: 'medium' } }))
      expect(label(d.best)).toBe('Opus 5.5 · high')
      expect(d.speak).toBe(true)
    }
  })

  test('Sonnet medium to high is worth a question', () => {
    const d = decide(verdict({ domain: 'website', confidence: 'high' }), first({ current: { model: 'sonnet', effort: 'medium' } }))
    expect(label(d.best)).toBe('Sonnet 5.5 · high')
    expect(d.speak).toBe(true)
  })

  test('a bigger step up (high to xhigh) still asks', () => {
    const d = decide(verdict({ tier: 'deep', flags: ['unknown_cause'], confidence: 'high' }), mid({ current: { model: 'opus', effort: 'high' } }))
    expect(d.speak).toBe(true)
  })

  test('a lighter model than the work needs still asks', () => {
    const d = decide(verdict({ tier: 'deep', domain: 'legal', confidence: 'high' }), mid({ current: { model: 'sonnet', effort: 'high' } }))
    expect(d.speak).toBe(true)
  })
})

describe('the question', () => {
  test('always three rows, each with its reason, and the switch cost where a model changes', () => {
    const v = verdict({ tier: 'deep', domain: 'legal', flags: ['outside_audience'], confidence: 'high', why: 'notice to an outside party.' })
    const current = { model: 'sonnet' as const, effort: 'high' as const }
    const ctx = mid({ current, contextTokens: 267_000, limits: { weekly: 42 } })
    const d = decide(v, ctx)
    const r = rows(d, v, current, { contextTokens: 267_000, isFirstPrompt: false, limits: ctx.limits, isStated: false })
    expect(r.map(x => x.label)).toEqual(['Best: Opus 5.5 · high', 'Balanced: same as Best', 'Keep: Sonnet 5.5 · high'])
    expect(r[0]!.description).toContain('legal')
    expect(r[0]!.description).toContain('Re-reads the 267K-token conversation once.')
    expect(r[1]!.description).toBe('Legal letters are never routed down to save usage.')
    expect(r[2]!.description).toContain('No re-read.')
    expect(questionText(d, v, ctx.limits)).toBe('Deep legal work: notice to an outside party. Weekly limit 42% used. Which setup should run it?')
  })

  test('a cheaper Balanced says how much it saves against Best', () => {
    const v = verdict({ domain: 'website', confidence: 'high' })
    const current = { model: 'opus' as const, effort: 'medium' as const }
    const d = decide(v, first({ current }))
    const r = rows(d, v, current, { contextTokens: 0, isFirstPrompt: true, limits: {}, isStated: false })
    expect(r[1]!.label).toBe('Balanced: Sonnet 5.5 · medium')
    expect(r[1]!.description).toMatch(/% less usage than Best/)
  })
})
