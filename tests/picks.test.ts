import { describe, expect, test } from 'claude-code/testing'
import { isSkippable, judgeUserMessage, parseVerdict, recentBlock, statedSetup, summarizeTurns, type MessageRow, type Verdict } from '../hooks/judge'
import { agree, decide, DISAGREE, isMechanical, label, movesDown, subagentJob, subagentRoute, tierOf, weight, type PickContext } from '../hooks/picks'
import { questionText, rows } from '../hooks/reasons'

// The judge reports facts; by default a build of a few files along a known pattern (standard).
const verdict = (v: Partial<Verdict> = {}): Verdict => ({
  work: '', continuation: false, action: 'build', scope: 'few', novelty: 'known', checkable: true,
  flags: [], risky: false, domain: 'code', ongoing: true, ...v,
})
// Facts that make each tier.
const light = (v: Partial<Verdict> = {}) => verdict({ action: 'lookup', scope: 'one', ...v })
const deep = (v: Partial<Verdict> = {}) => verdict({ scope: 'many', ...v })
const mid = (c: Partial<PickContext> = {}): PickContext => ({
  current: { model: 'opus', effort: 'medium' }, isFirstPrompt: false, contextTokens: 200_000, limits: {}, ...c,
})
const first = (c: Partial<PickContext> = {}): PickContext => mid({ isFirstPrompt: true, contextTokens: 0, ...c })

describe('the six replay cases from the plan', () => {
  test('a rename mid-session is light and silent', () => {
    const d = decide(verdict({ action: 'ship', scope: 'one', domain: 'admin', ongoing: false }), mid())
    expect(d.speak).toBe(false)
  })

  test('a legal notice is deep and never routed down', () => {
    const v = verdict({ action: 'draft', scope: 'one', domain: 'legal', flags: ['outside_audience'] })
    expect(tierOf(v)).toBe('deep')
    const fromSonnet = decide(v, first({ current: { model: 'sonnet', effort: 'medium' } }))
    expect(fromSonnet.neverDown).toBe(true)
    expect(label(fromSonnet.best)).toBe('Opus 5.5 · high')
    expect(label(fromSonnet.balanced)).toBe('Opus 5.5 · high')
    const fromFable = decide(v, mid({ current: { model: 'fable', effort: 'high' } }))
    expect(fromFable.speak).toBe(false)
  })

  test('running the production migration is risky: Opus 5.5 at high', () => {
    const v = verdict({ risky: true, flags: ['production', 'irreversible'] })
    const d = decide(v, first({ current: { model: 'sonnet', effort: 'medium' } }))
    expect(d.best.model).toBe('opus')
    expect(weight(d.best)).toBeGreaterThanOrEqual(weight({ model: 'opus', effort: 'high' }))
    expect(d.balanced).toEqual(d.best)
  })

  test('"ok do it" after a design discussion keeps the setup; a longer one inherits deep', () => {
    expect(isSkippable('ok do it')).toBe(true)
    const v = verdict({ scope: 'one', continuation: true })
    const d = decide(v, mid({ previousTier: 'deep', current: { model: 'opus', effort: 'high' } }))
    expect(d.tier).toBe('deep')
    expect(d.neverDown).toBe(true)
    expect(d.speak).toBe(false)
  })

  test('a Next.js form at session start: Opus 5.5 medium, Sonnet 5.5 high as Balanced (4.7)', () => {
    const d = decide(verdict({ domain: 'website' }), first({ current: { model: 'sonnet', effort: 'medium' } }))
    expect(label(d.best)).toBe('Opus 5.5 · medium')
    expect(label(d.balanced)).toBe('Sonnet 5.5 · high')
    expect(d.speak).toBe(true)
  })

  test('a 300K conversation on Opus prefers an effort change for Balanced', () => {
    const d = decide(verdict({ domain: 'website' }), mid({ contextTokens: 300_000, current: { model: 'opus', effort: 'high' } }))
    expect(label(d.balanced)).toBe('Opus 5.5 · low')
  })
})

describe('the other rules', () => {
  test('weekly usage at 80% makes Balanced cheaper', () => {
    const v = deep()
    const relaxed = decide(v, first({ current: { model: 'opus', effort: 'high' } }))
    const tight = decide(v, first({ current: { model: 'opus', effort: 'high' }, limits: { weekly: 80 } }))
    expect(weight(tight.balanced)).toBeLessThan(weight(relaxed.balanced))
  })

  test('two-prompt rule: a one-off aside never moves the session down', () => {
    const d = decide(verdict({ domain: 'website', ongoing: false }), mid({ current: { model: 'opus', effort: 'high' } }))
    expect(weight(d.best)).toBeGreaterThanOrEqual(weight({ model: 'opus', effort: 'high' }))
    expect(weight(d.balanced)).toBeGreaterThanOrEqual(weight({ model: 'opus', effort: 'high' }))
  })

  test('Haiku is never offered for the main session: light work gets Sonnet 5.5 at low (4.7)', () => {
    for (const ctx of [first(), mid({ contextTokens: 50_000, previousTier: 'light' })]) {
      const d = decide(light({ domain: 'admin' }), ctx)
      expect(label(d.best)).toBe('Sonnet 5.5 · low')
      expect(label(d.balanced)).toBe('Sonnet 5.5 · low')
    }
  })

  test('a prompt that names its model and effort gets them', () => {
    const named = statedSetup('Build R34 Pass 9. Model per R34 §3: Sonnet 5.5 at medium.')
    expect(named).toEqual({ model: 'sonnet', effort: 'medium' })
    const d = decide(deep(), first({ stated: { model: 'sonnet', effort: 'medium' } }))
    expect(label(d.best)).toBe('Sonnet 5.5 · medium')
  })

  test('an older-generation session is offered the current one', () => {
    const d = decide(deep(), first({ current: { model: 'opus', effort: 'high' }, currentIsLatest: false }))
    expect(d.speak).toBe(true)
  })

  test('the judge reply is read leniently and refused when broken', () => {
    expect(parseVerdict('Sure: {"work":"a notice","action":"draft","domain":"legal","flags":["money","bogus"]} done')?.flags).toEqual(['money'])
    expect(parseVerdict('{"work":"one draft","action":"edit","scope":"one","domain":"copy","}')?.action).toBe('edit')
    // a missing scope reads as a few; a missing checkable does not make the work harder
    expect(parseVerdict('{"action":"build"}')).toMatchObject({ scope: 'few', novelty: 'known', checkable: true, continuation: false, ongoing: true })
    expect(parseVerdict('{"action":"huge"}')).toBe(undefined)
    // the phase 3 reply, a tier and no action, is not read
    expect(parseVerdict('{"tier":"deep","domain":"code"}')).toBe(undefined)
    expect(parseVerdict('no json')).toBe(undefined)
  })
})

describe('mechanical and risky acts', () => {
  test('installing a build on the device mid-session stays silent on Sonnet medium', () => {
    const v = verdict({ action: 'ship', scope: 'one', domain: 'ios', flags: ['production'], risky: true })
    const d = decide(v, mid({ current: { model: 'sonnet', effort: 'medium' } }))
    expect(d.speak).toBe(false)
  })

  test('pushing to main is never sent to Fable, and never down', () => {
    const v = verdict({ action: 'ship', scope: 'one', flags: ['production', 'irreversible', 'relied_on'], risky: true, continuation: true })
    const d = decide(v, mid({ current: { model: 'sonnet', effort: 'medium' }, previousTier: 'deep' }))
    expect(d.best.model).not.toBe('fable')
    expect(d.speak).toBe(false)
    expect(weight(d.balanced)).toBeGreaterThanOrEqual(weight({ model: 'sonnet', effort: 'medium' }))
  })

  test('frontier is a failed attempt at work already rated deep', () => {
    const failed = deep({ flags: ['failed_before'] })
    expect(decide(failed, first()).tier).toBe('deep')
    expect(decide(failed, mid({ previousTier: 'standard' })).tier).toBe('deep')
    expect(decide(failed, mid({ previousTier: 'deep' })).tier).toBe('frontier')
    // many sources on new ground is deep, not frontier
    expect(decide(deep({ action: 'research', novelty: 'new' }), first()).tier).toBe('deep')
  })

  test('Fable is offered only after Opus at xhigh has also fallen short, and never for research (4.7)', () => {
    const failed = deep({ flags: ['failed_before'] })
    const onHigh = decide(failed, mid({ previousTier: 'deep', current: { model: 'opus', effort: 'high' } }))
    expect(label(onHigh.best)).toBe('Opus 5.5 · xhigh')
    const onXhigh = decide(failed, mid({ previousTier: 'deep', current: { model: 'opus', effort: 'xhigh' } }))
    expect(label(onXhigh.best)).toBe('Fable 5.1 · high')
    const research = decide(deep({ action: 'research', domain: 'research', flags: ['failed_before'] }), mid({ previousTier: 'deep', current: { model: 'opus', effort: 'xhigh' } }))
    expect(research.best.model).toBe('opus')
  })

  test('a risky act that needs thought still goes to Opus at high', () => {
    const d = decide(verdict({ risky: true, flags: ['production'] }), first({ current: { model: 'sonnet', effort: 'medium' } }))
    expect(label(d.best)).toBe('Opus 5.5 · high')
  })
})

describe('noise', () => {
  test('a small effort step up on the same model stays silent', () => {
    const d = decide(deep(), mid({ current: { model: 'opus', effort: 'medium' } }))
    expect(label(d.best)).toBe('Opus 5.5 · high')
    expect(d.speak).toBe(false)
  })

  test('legal, tender and risky work on Opus medium still asks for high', () => {
    for (const v of [
      verdict({ action: 'draft', scope: 'one', domain: 'legal', flags: ['outside_audience'] }),
      verdict({ action: 'draft', domain: 'tender', flags: ['outside_audience'] }),
      verdict({ risky: true, flags: ['production'] }),
    ]) {
      const d = decide(v, mid({ current: { model: 'opus', effort: 'medium' } }))
      expect(label(d.best)).toBe('Opus 5.5 · high')
      expect(d.speak).toBe(true)
    }
  })

  test('Sonnet medium to high is worth a question', () => {
    const d = decide(verdict({ domain: 'spreadsheet' }), first({ current: { model: 'sonnet', effort: 'medium' } }))
    expect(label(d.best)).toBe('Sonnet 5.5 · high')
    expect(d.speak).toBe(true)
  })

  test('a bigger step up (high to xhigh) still asks', () => {
    const d = decide(verdict({ action: 'debug', flags: ['unknown_cause'] }), mid({ current: { model: 'opus', effort: 'high' } }))
    expect(label(d.best)).toBe('Opus 5.5 · xhigh')
    expect(d.speak).toBe(true)
  })

  test('a lighter model than the work needs still asks', () => {
    const d = decide(verdict({ action: 'draft', domain: 'legal', flags: ['outside_audience'] }), mid({ current: { model: 'sonnet', effort: 'high' } }))
    expect(d.speak).toBe(true)
  })
})

describe('v2 review fixes (section 3)', () => {
  test('bug 1: on Opus medium, a failed fix or a production change asks; plain deep work and its continuations stay silent', () => {
    for (const flags of [['failed_before'], ['production']] as const) {
      const d = decide(deep({ flags: [...flags] }), mid())
      expect(label(d.best)).toBe('Opus 5.5 · high')
      expect(d.speak).toBe(true)
    }
    expect(decide(deep({ continuation: true }), mid({ previousTier: 'deep' })).speak).toBe(false)
    expect(decide(deep({ domain: 'legal', continuation: true }), mid({ previousTier: 'deep' })).speak).toBe(true)
  })

  test('bug 4: running a command with an unknown cause, or many separate acts, is not mechanical', () => {
    const ci = verdict({ action: 'ship', scope: 'one', flags: ['unknown_cause'] })
    expect(isMechanical(ci)).toBe(false)
    const d = decide(ci, first())
    expect(d.tier).toBe('standard')
    expect(d.best.model).not.toBe('haiku')
    expect(isMechanical(verdict({ action: 'ship', scope: 'many' }))).toBe(false)
    expect(decide(verdict({ action: 'ship', scope: 'many' }), first()).tier).toBe('standard')
  })

  test('bug 6: short commands are judged; only bare continuations skip', () => {
    for (const t of ['ok', 'yes', 'go on', 'ok do it', 'Yes, go ahead.', 'continue', '/picks log']) expect(isSkippable(t)).toBe(true)
    for (const t of ['deploy to prod now', 'push it', 'delete the old branch', 'try again']) expect(isSkippable(t)).toBe(false)
  })

  test('bug 7: in a 900K conversation on Fable, deep work never drops to Fable low', () => {
    const d = decide(deep(), mid({ contextTokens: 900_000, current: { model: 'fable', effort: 'high' } }))
    expect(label(d.best)).toBe('Fable 5.1 · high')
    expect(d.balanced.effort).not.toBe('low')
  })

  test('bug 8: a move to a lower model family counts as down, so it needs two runs that agree', () => {
    const ctx = first({ current: { model: 'opus', effort: 'low' } })
    const d = decide(verdict({ domain: 'website' }), ctx)
    expect(label(d.balanced)).toBe('Sonnet 5.5 · high')
    expect(movesDown(d, ctx)).toBe(true)
    const held = agree(d, undefined, verdict({ domain: 'website' }), ctx)
    expect(label(held.balanced)).toBe('Opus 5.5 · low')
  })

  test('bug 9: with the week nearly used, runs that disagree still give a Balanced one notch lower', () => {
    const tight = first({ current: { model: 'opus', effort: 'high' }, limits: { weekly: 92 } })
    const d = decide(deep(), tight)
    const unsure = decide(verdict({ action: 'debug', flags: ['unknown_cause'] }), tight)
    expect(label(agree(d, unsure, deep(), tight).balanced)).toBe('Opus 5.5 · medium')
    expect(label(decide(deep({ domain: 'legal' }), tight).balanced)).toBe('Opus 5.5 · high')
  })

  test('bug 10: only a Recommended or Model line or sentence names the setup', () => {
    for (const t of [
      'check why Opus medium stays silent on legal prompts',
      'Do you really think this task needs Opus at High effort?',
      'I selected Fable 5.1 High. After I clicked that, I got the error.',
    ]) expect(statedSetup(t)).toBe(undefined)
    expect(statedSetup('Recommended: Opus 5.5 at medium effort.\n\nBuild phase 1.')).toEqual({ model: 'opus', effort: 'medium' })
    expect(statedSetup('Background.\n\nTask:\nRecommended: Opus 5.5 at xhigh effort (policy reasoning).')).toEqual({ model: 'opus', effort: 'xhigh' })
    expect(statedSetup('Local commit only. Model: Opus 5.5, high effort.\n\nShared notes')).toEqual({ model: 'opus', effort: 'high' })
    expect(statedSetup('Build the mod. Recommended model for this session: Opus 5.5 at high effort.')).toEqual({ model: 'opus', effort: 'high' })
  })
})

// Openings of real briefs from the 13 to 17 Oct transcripts (section 4.6, phase 2).
describe('subagents: routed by type and job, with no judge', () => {
  const COPY_REVIEW = 'Read ~/.claude/agents/copy-reviewer.md, ignore its frontmatter, follow it exactly, use only Read, Grep and Glob. Channel: X. Draft: /Users/safemode/Desktop/draft.md'
  const FINISH_REVIEW = 'You are the Impeccable finish reviewer for a finished print document. Read and follow exactly the role file at /Users/safemode/.claude/skills/impeccable/reference/finish.md'
  const CODE_REVIEW = 'Read-only review; do not edit, commit or push anything. Review the Claude Code mod at /Users/safemode/mods/model-advisor (files: hooks/judge.ts, hooks/picks.ts).'
  const AUDIT = 'Work in /Users/safemode/Desktop/Claude Code/Claude Optimisation. Read-only audit of Ajay\'s whole Claude Code setup for Task 2.'
  const RESEARCH = 'Research task, read-only, no files to write. Today is 17 Oct 2026. Use the parallel-search MCP web_search/web_fetch tools first.'
  const BENCH = 'Bench test, NEW copy stack (house-copy, narrowed review loop of 14 Oct), case 04. Run the house-copy skill end to end, exactly as the main session would.'
  const WRITER = 'You are one writer in a blind bake-off of X writing stacks. Write X copy for Ajay\'s personal X account for one case, from the brief alone. Do not edit the skill files.'
  const PATCH = 'Task: apply the approved edits to Ajay\'s local fork of linkedin-skills, as git commits. Do not change anything outside the fork.'
  const LATE = `You are a research agent. Re-rank skills for writing X hooks. ${'Context on the bench. '.repeat(60)}Earlier shallow clones exist, read-only, under /private/tmp.`

  test('Explore is a search; copy-reviewer and the finish reviewer are reviews', () => {
    expect(subagentJob('Explore', 'Find every call site of fetchUser')).toBe('search')
    expect(subagentJob('copy-reviewer', 'Draft: /tmp/x.md')).toBe('review')
    expect(subagentJob('impeccable-finish-reviewer', 'Review the build')).toBe('review')
  })

  test('a general-purpose brief that opens as a reviewer, or as a read-only review or audit, is a review', () => {
    for (const p of [COPY_REVIEW, FINISH_REVIEW, CODE_REVIEW, AUDIT]) expect(subagentJob('general-purpose', p)).toBe('review')
    expect(subagentJob('claude', CODE_REVIEW)).toBe('review')
  })

  test('a general-purpose brief that says read-only near its start is a search', () => {
    expect(subagentJob('general-purpose', RESEARCH)).toBe('search')
  })

  test('writers, editors and bench arms are work, even when they mention review or say not to edit something', () => {
    for (const p of [BENCH, WRITER, PATCH, LATE]) expect(subagentJob('general-purpose', p)).toBe('work')
  })

  test('types with a model or a job of their own are not routed', () => {
    for (const t of ['design-critic', 'claude-code-guide', 'Plan', 'fork', 'statusline-setup', 'impeccable-documenter'])
      expect(subagentJob(t, RESEARCH)).toBe(undefined)
  })

  test('searches go to Haiku 5.5 medium, reviews to Sonnet 5.5 high, work keeps the parent model at medium', () => {
    const parent = { model: 'opus' as const, effort: 'high' as const }
    expect(subagentRoute('search', parent, false)).toEqual({ model: 'haiku', effort: 'medium' })
    expect(subagentRoute('review', parent, false)).toEqual({ model: 'sonnet', effort: 'high' })
    expect(subagentRoute('work', parent, false)).toEqual({ model: 'opus', effort: 'medium' })
    // With no pick active the subagent inherits the session's model already.
    expect(subagentRoute('work', undefined, false)).toEqual({ effort: 'medium' })
  })

  test('inside a never-route-down task every job keeps the parent setup', () => {
    const parent = { model: 'opus' as const, effort: 'xhigh' as const }
    for (const job of ['search', 'review', 'work'] as const) {
      expect(subagentRoute(job, parent, true)).toEqual(parent)
      expect(subagentRoute(job, undefined, true)).toEqual({})
    }
  })
})

describe('the question', () => {
  test('always three rows, each with its reason, and the switch cost where a model changes', () => {
    const v = verdict({ action: 'draft', scope: 'one', domain: 'legal', flags: ['outside_audience'], work: 'notice to an outside party.' })
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
    const v = verdict({ domain: 'spreadsheet' })
    const current = { model: 'opus' as const, effort: 'medium' as const }
    const d = decide(v, first({ current }))
    const r = rows(d, v, current, { contextTokens: 0, isFirstPrompt: true, limits: {}, isStated: false })
    expect(r[1]!.label).toBe('Balanced: Sonnet 5.5 · medium')
    expect(r[1]!.description).toMatch(/% less usage than Best/)
  })
})

describe('phase 4: the judge reports facts and code computes the tier (4.1)', () => {
  test('the tier table', () => {
    const cases: [Partial<Verdict>, string][] = [
      [{ action: 'lookup', scope: 'one' }, 'light'],
      [{ action: 'ship', scope: 'one' }, 'light'],
      [{ action: 'ship', scope: 'many' }, 'standard'],
      [{ action: 'lookup', scope: 'one', flags: ['must_reconcile'] }, 'standard'],
      [{ action: 'edit', scope: 'one' }, 'standard'],
      [{ action: 'edit', scope: 'many' }, 'standard'],
      [{ action: 'build', scope: 'few' }, 'standard'],
      [{ action: 'draft', scope: 'one' }, 'standard'],
      [{ action: 'build', scope: 'many' }, 'deep'],
      [{ action: 'plan', scope: 'few', novelty: 'new' }, 'deep'],
      [{ action: 'answer', scope: 'one', checkable: false }, 'deep'],
      [{ action: 'debug', scope: 'one', flags: ['unknown_cause'] }, 'deep'],
      [{ action: 'edit', scope: 'few', flags: ['failed_before'] }, 'deep'],
    ]
    for (const [facts, tier] of cases) expect([facts, tierOf(verdict(facts))]).toEqual([facts, tier])
  })

  test('stakes never raise the tier: production, money and irreversible only keep work from moving down', () => {
    const v = verdict({ flags: ['production', 'money', 'irreversible'] })
    expect(tierOf(v)).toBe('standard')
    expect(decide(v, mid()).neverDown).toBe(true)
  })

  test('target 1: a go-ahead or status reply that resumes real work is not "ship it"', () => {
    // "done, I've signed in" when the next step is reading the dashboard and checking the numbers
    const status = verdict({ action: 'lookup', scope: 'few', continuation: true })
    expect(isMechanical(status)).toBe(false)
    expect(decide(status, mid()).tier).toBe('standard')
    expect(decide(status, mid({ previousTier: 'deep' })).tier).toBe('deep')
    // "push it" is still mechanical, and stays light after deep work
    const push = verdict({ action: 'ship', scope: 'one', continuation: true })
    expect(isMechanical(push)).toBe(true)
    expect(decide(push, mid({ previousTier: 'deep' })).tier).toBe('light')
  })

  test('target 2: legal and tender text for an outside party, and numbers that must tie out, are deep', () => {
    for (const action of ['draft', 'edit', 'answer'] as const)
      expect(tierOf(verdict({ action, scope: 'one', domain: 'legal', flags: ['outside_audience'] }))).toBe('deep')
    expect(tierOf(verdict({ action: 'edit', scope: 'few', domain: 'ledger', flags: ['must_reconcile'] }))).toBe('deep')
    // a post the person revises and publishes stays standard
    expect(tierOf(verdict({ action: 'draft', scope: 'one', domain: 'copy', flags: ['outside_audience', 'relied_on'] }))).toBe('standard')
  })

  test('never-route-down work that needs thought gets Opus 5.5 at medium or above, whatever its tier', () => {
    const question = light({ domain: 'legal' })
    const d = decide(question, first({ current: { model: 'sonnet', effort: 'low' } }))
    expect(d.tier).toBe('light')
    expect(label(d.best)).toBe('Opus 5.5 · medium')
    expect(d.balanced).toEqual(d.best)
  })

  test('public text is never routed down: copy, and website changes the public reads', () => {
    expect(decide(verdict({ action: 'draft', scope: 'one', domain: 'copy' }), mid()).neverDown).toBe(true)
    expect(decide(verdict({ action: 'edit', domain: 'website', flags: ['outside_audience'] }), mid()).neverDown).toBe(true)
    expect(decide(verdict({ domain: 'website' }), mid()).neverDown).toBe(false)
    expect(decide(light({ domain: 'copy' }), mid()).neverDown).toBe(false)
  })
})

describe('phase 4: two runs before a move down (4.5)', () => {
  const ctx = first({ current: { model: 'opus', effort: 'high' } })

  test('only a move down asks for a second run, and never for a setup the prompt names', () => {
    expect(movesDown(decide(deep(), ctx), ctx)).toBe(true)
    expect(movesDown(decide(deep({ domain: 'legal' }), ctx), ctx)).toBe(false)
    expect(movesDown(decide(verdict({ action: 'debug', flags: ['unknown_cause'] }), ctx), ctx)).toBe(false)
    const named = first({ current: { model: 'opus', effort: 'high' }, stated: { model: 'sonnet', effort: 'medium' } })
    expect(movesDown(decide(deep(), named), named)).toBe(false)
  })

  test('the move stands when both runs go down, at the higher of the two', () => {
    const d = decide(light(), ctx)
    const both = agree(d, decide(verdict(), ctx), light(), ctx)
    expect(label(both.best)).toBe('Opus 5.5 · medium')
    expect(both.held).toBe(undefined)
    expect(both.speak).toBe(true)
  })

  test('when the week is nearly used, a second run that calls the work never-route-down keeps Balanced where it is', () => {
    const tight = first({ current: { model: 'opus', effort: 'high' }, limits: { weekly: 92 } })
    const held = agree(decide(deep(), tight), decide(deep({ flags: ['production'] }), tight), deep(), tight)
    expect(label(held.balanced)).toBe('Opus 5.5 · high')
    expect(held.neverDown).toBe(true)
  })

  test('it is held when the second run disagrees or fails', () => {
    const d = decide(deep(), ctx)
    for (const second of [decide(deep({ domain: 'legal' }), ctx), undefined]) {
      const held = agree(d, second, deep(), ctx)
      expect(label(held.balanced)).toBe('Opus 5.5 · high')
      expect(held.held).toBe(DISAGREE)
      expect(held.speak).toBe(false)
    }
  })
})

describe('phase 4: the judge sees what was done (4.2)', () => {
  const rows: MessageRow[] = [
    { role: 'user', text: 'Add retries to the sync engine.' },
    { role: 'assistant', text: 'Let me read the file.', toolUses: [{ tool: 'Read', input: { file_path: '/repo/sync.ts' } }] },
    { role: 'user', text: '' },
    {
      role: 'assistant', text: '', toolUses: [
        { tool: 'Edit', input: { file_path: '/repo/sync.ts' } },
        { tool: 'Bash', input: {}, isError: true },
        { tool: 'mcp__claude-in-chrome__navigate', input: {} },
      ],
    },
    { role: 'user', text: '' },
    { role: 'assistant', text: 'Retries are in, but the CI test still fails. Should I look at the CI config?' },
    { role: 'user', text: '<system-reminder>\nworktree\n</system-reminder>\nyes' },
    { role: 'assistant', text: 'The CI image pins an old Node.' },
  ]

  test('each turn is what the person typed, one line of what was done, and the last message', () => {
    const turns = summarizeTurns(rows)
    expect(turns).toEqual([
      {
        typed: 'Add retries to the sync engine.',
        work: 'tools Read 1, Edit 1, Bash 1, claude-in-chrome:navigate 1; edited sync.ts; errors: Bash 1',
        reply: 'Retries are in, but the CI test still fails. Should I look at the CI config?',
      },
      { typed: 'yes', work: 'no tools', reply: 'The CI image pins an old Node.' },
    ])
  })

  test('what the person typed is shown for the last two turns only, and the newest turn survives a long history', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ typed: `ask ${i}`, work: 'no tools', reply: 'x'.repeat(i === 4 ? 9000 : 10) }))
    const block = recentBlock(many.slice(0, 3))
    expect(block).not.toContain('person: ask 0')
    expect(block).toContain('person: ask 1')
    expect(block).toContain('person: ask 2')
    expect(recentBlock(many)).toContain('person: ask 4')
    expect(recentBlock(many)).not.toContain('ask 2')
  })

  test('the message names the work so far and keeps the request apart', () => {
    const text = judgeUserMessage('carry on', summarizeTurns(rows), { isFirstPrompt: false, contextTokens: 120_000, previousTier: 'deep' })
    expect(text).toContain('The work so far was rated deep.')
    expect(text).toContain('assistant did: tools Read 1')
    expect(text).toMatch(/<request>\ncarry on\n<\/request>$/)
  })
})
