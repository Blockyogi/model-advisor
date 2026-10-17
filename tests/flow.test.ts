import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteResult, On, TurnStepInput } from 'claude-code'

const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const deepLegal = JSON.stringify({
  tier: 'deep', domain: 'legal', flags: ['outside_audience'], risky: false,
  continuation: false, ongoing: true, confidence: 'high', why: 'legal notice to a builder',
})
const NOTICE = 'Draft the RERA legal notice to the builder for delayed possession.'
const composer = { wait: false, origin: { kind: 'composer' as const } }

const answered = (): ModelCompleteResult => ({ isAnswered: true, text: deepLegal, usage })
const reply = (v: object): ModelCompleteResult => ({ isAnswered: true, text: JSON.stringify(v), usage })

type World = {
  asked: string[][]; descriptions: string[][]; logs: string[]; toasts: string[]; status: (string | undefined)[]
  seen: TurnStepInput[]; judged: number; systems: string[]; prompts: string[]
  model: string; rows: { role: 'user' | 'assistant'; text: string }[]; surfaces: string[]; store: Map<string, unknown>
}

// `answer` returns null to dismiss the question.
function session(
  on: On, answer: (labels: string[]) => string | null, judge: (n: number) => ModelCompleteResult = answered,
  env: Record<string, string> = { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
): World {
  const w: World = {
    asked: [], descriptions: [], logs: [], toasts: [], status: [], seen: [], judged: 0, systems: [], prompts: [],
    model: 'claude-sonnet-5-5', rows: [], surfaces: ['desktop'], store: new Map(),
  }
  // The plugin's store, kept here so a test can read what was logged.
  on('store.get', (_$, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_$, e) => (w.store.set(e.key, JSON.parse(JSON.stringify(e.value))), { value: undefined }))
  on('store.delete', (_$, e) => (w.store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  mock.env(on, env)
  on('session.model', () => ({ value: w.model }))
  on('session.messages', () => ({ value: w.rows.map(r => ({ ...r, toolUses: [] })) }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.turns', () => ({ value: w.rows.filter(r => r.role === 'user').length }))
  on('session.surfaces', () => ({ value: w.surfaces as never }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: 0 }, rateLimits: [] } }))
  on('settings.read', () => ({ value: { effortLevel: 'medium' } }))
  on('model.complete', (_$, e) => ((w.judged += 1), w.systems.push(e.system ?? ''), w.prompts.push(e.prompt), { value: judge(w.judged) }))
  on('ui.status', (_$, e) => (w.status.push(e.text), { value: undefined }))
  on('ui.toast', (_$, e) => (w.toasts.push(e.text), { value: undefined }))
  on('ui.log', (_$, e) => (w.logs.push(e.text), { value: undefined }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const q = e.questions[0]!
    const labels = q.options.map(o => o.label)
    w.asked.push(labels)
    w.descriptions.push(q.options.map(o => o.description))
    const choice = answer(labels)
    if (choice === null) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [q.question]: choice } } }
  })
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'inherit', agentId: 'a1' }) as never)
  on('command.run', () => ({ text: 'unanswered' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.step', async function* (_$, e) {
    w.seen.push(e)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })
  return w
}

// One request as the picker sends it (Sonnet 5.5 · medium unless given).
async function step($: Engine, w: World, index: number, model = 'claude-sonnet-5-5', effort: 'medium' | 'high' = 'medium') {
  const stream = $.turn.step({ turnId: 't1', index, model, effort, messageCount: 1 })
  for await (const _ of stream) void _
  return w.seen.at(-1)
}

test('Best runs every later request on the pick, and the status says what really runs', async ($, on) => {
  const w = session(on, labels => labels[0]!)
  const r = await $.prompt.submit({ text: NOTICE, ...composer })
  expect(r.text).toBe(NOTICE)
  expect(w.asked).toEqual([['Best: Opus 5.5 · high', 'Balanced: same as Best', 'Keep: Sonnet 5.5 · medium']])
  expect(w.descriptions.at(-1)?.[1]).toBe('Legal letters are never routed down to save usage.')
  expect(w.status.at(-1)).toBe('running Opus 5.5 · high (undo: /picks clear)')
  for (const i of [0, 1]) {
    const s = await step($, w, i)
    expect([s?.model, s?.effort]).toEqual(['claude-opus-5-5', 'high'])
  }
  expect(w.logs).toEqual([])
})

const picks = async ($: Engine, args: string) =>
  (await $.command.run({ command: 'picks', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })).text

test('/picks clear goes back to the picker', async ($, on) => {
  const w = session(on, labels => labels[0]!)
  await $.prompt.submit({ text: NOTICE, ...composer })
  await step($, w, 0)
  const out = { text: await picks($, 'clear') }
  expect(out.text).toContain('Dropped the advisor')
  expect(w.status.at(-1)).toBe(undefined)
  expect((await step($, w, 1))?.model).toBe('claude-sonnet-5-5')
})

test('a change made in the picker wins over the pick', async ($, on) => {
  const w = session(on, labels => labels[0]!)
  await $.prompt.submit({ text: NOTICE, ...composer })
  await step($, w, 0)
  const after = await step($, w, 1, 'claude-sonnet-5-5', 'high')
  expect([after?.model, after?.effort]).toEqual(['claude-sonnet-5-5', 'high'])
  expect(w.toasts.some(t => t.includes('you changed the model or effort'))).toBe(true)
})

test('Keep leaves every request as the picker sends it', async ($, on) => {
  const w = session(on, labels => labels.at(-1)!)
  await $.prompt.submit({ text: NOTICE, ...composer })
  expect((await step($, w, 0))?.model).toBe('claude-sonnet-5-5')
})

test('a named setup is Best, and the advisor keeps its own lighter pick as Balanced', async ($, on) => {
  const w = session(on, labels => labels[0]!)
  await $.prompt.submit({ text: `Model and effort per the plan: Fable 5.1, high. ${NOTICE}`, ...composer })
  expect(w.asked).toEqual([['Best: Fable 5.1 · high', 'Balanced: Opus 5.5 · high', 'Keep: Sonnet 5.5 · medium']])
  expect(w.descriptions.at(-1)?.[0]).toContain('Your prompt names this setup')
})

test('a short continuation never calls the judge', async ($, on) => {
  const w = session(on, labels => labels[0]!)
  await $.prompt.submit({ text: 'ok do it', ...composer })
  expect(w.judged).toBe(0)
  expect(w.asked).toEqual([])
})

test('a judge failure sends the prompt unchanged and says so on the first prompt', async ($, on) => {
  const w = session(on, labels => labels[0]!, () => ({ isAnswered: false, reason: 'aborted', usage }))
  const r = await $.prompt.submit({ text: NOTICE, ...composer })
  expect(r.text).toBe(NOTICE)
  expect(w.asked).toEqual([])
  expect(w.toasts).toEqual(['Model advisor: could not check this prompt, so it runs as set'])
})

test('the first prompt gets one brief toast when nothing needs to change', async ($, on) => {
  const w = session(on, labels => labels[0]!)
  await $.prompt.submit({ text: `Model and effort: Sonnet 5.5, medium. ${NOTICE}`, ...composer })
  expect(w.asked).toEqual([])
  expect(w.toasts).toEqual(['Model advisor: Sonnet 5.5 · medium fits this work (your prompt names it)'])
})

test('the about setting reaches the judge', { options: { about: 'Wedding photographer who also runs a small online shop.' } }, async ($, on) => {
  const w = session(on, labels => labels[0]!)
  await $.prompt.submit({ text: NOTICE, ...composer })
  expect(w.systems[0]).toContain('About the person: Wedding photographer who also runs a small online shop.')
})

test('with no about setting the judge gets a neutral description', async ($, on) => {
  const w = session(on, labels => labels[0]!)
  await $.prompt.submit({ text: NOTICE, ...composer })
  expect(w.systems[0]).toContain('About the person: Their work is a mix of software')
})

test('prompts from the desktop app, a hand-off or with no named source are judged', async ($, on) => {
  const w = session(on, labels => labels.at(-1)!)
  for (const origin of [{ kind: 'sdk' as const }, { kind: 'unclassified' as const }, { kind: 'coordinator' as const }, { kind: 'bridge' as const }])
    await $.prompt.submit({ text: NOTICE, wait: false, origin })
  expect(w.judged).toBe(4)
})

test('background notices and scheduled runs are not judged', async ($, on) => {
  const w = session(on, labels => labels.at(-1)!)
  for (const origin of [{ kind: 'task-notification' as const }, { kind: 'scheduled-trigger' as const }])
    await $.prompt.submit({ text: NOTICE, wait: false, origin })
  expect(w.judged).toBe(0)
})

test('the app reminder blocks are stripped before judging', async ($, on) => {
  const w = session(on, labels => labels.at(-1)!)
  await $.prompt.submit({ text: `<system-reminder>\nYou are operating in a git worktree.\n</system-reminder>\n${NOTICE}`, ...composer })
  expect(w.prompts[0]).toContain(NOTICE)
  expect(w.prompts[0]).not.toContain('git worktree')
})

test('a prompt that is only an app reminder is skipped', async ($, on) => {
  const w = session(on, labels => labels.at(-1)!)
  await $.prompt.submit({ text: '<system-reminder>\nLinked sessions now: none.\n</system-reminder>', ...composer })
  expect(w.judged).toBe(0)
})

describe('v2 review fixes (section 3) and the log (section 4.8)', () => {
  const deepCode = { tier: 'deep', domain: 'code', flags: ['many_sources'], risky: false, mechanical: false, continuation: false, ongoing: true, confidence: 'high', why: 'multi-file refactor' }
  const push = { tier: 'light', domain: 'code', flags: [], risky: false, mechanical: true, continuation: false, ongoing: true, confidence: 'high', why: 'git push' }
  const nextStep = { tier: 'light', domain: 'code', flags: [], risky: false, mechanical: false, continuation: true, ongoing: true, confidence: 'high', why: 'next step' }
  const lookup = { tier: 'standard', domain: 'code', flags: [], risky: false, mechanical: false, continuation: false, ongoing: true, confidence: 'high', why: 'find call sites' }

  test('bug 2: a dismissed question is logged as dismissed, not Keep', async ($, on) => {
    session(on, () => null)
    await $.prompt.submit({ text: NOTICE, ...composer })
    const log = await picks($, 'log')
    expect(log).toContain('Keep 0')
    expect(log).toContain('dismissed 1')
  })

  test('bug 2: with no surface to ask on, the question is logged as no one to ask', async ($, on) => {
    const w = session(on, () => null)
    w.surfaces = []
    await $.prompt.submit({ text: NOTICE, ...composer })
    expect(await picks($, 'log')).toContain('no one to ask 1')
  })

  test('bug 2: prompts from a claude -p run are not judged', async ($, on) => {
    const w = session(on, labels => labels[0]!, answered, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })
    await $.prompt.submit({ text: NOTICE, wait: false, origin: { kind: 'sdk' } })
    expect(w.judged).toBe(0)
  })

  test('bug 3: a push between deep work and its next step does not reset the tier', async ($, on) => {
    const w = session(on, labels => labels.at(-1)!, n => reply([deepCode, push, nextStep][n - 1]!))
    await $.prompt.submit({ text: 'Refactor the sync engine across the five services so retries are idempotent.', ...composer })
    w.rows = [{ role: 'user', text: 'Refactor the sync engine' }, { role: 'assistant', text: 'Done with step 2.' }]
    await $.prompt.submit({ text: 'commit and push this to the branch now', ...composer })
    await $.prompt.submit({ text: 'carry on with step 3 of the plan please', ...composer })
    expect(w.prompts[2]).toContain('Tier of the work so far: deep.')
  })

  test('bug 5: a model change in the picker counts before the next prompt is judged, and is logged', async ($, on) => {
    const w = session(on, labels => labels[0]!)
    await $.prompt.submit({ text: NOTICE, ...composer })
    await step($, w, 0)
    w.model = 'claude-haiku-5-5'
    await $.prompt.submit({ text: NOTICE, ...composer })
    expect(w.asked.length).toBe(2)
    expect(w.asked[1]!.at(-1)).toBe('Keep: Haiku 5.5 · medium')
    expect(await picks($, 'log')).toContain('changed the picker 1')
  })

  test('bug 11: /clear drops the pick', async ($, on) => {
    const w = session(on, labels => labels[0]!)
    await $.prompt.submit({ text: NOTICE, ...composer })
    await step($, w, 0)
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    expect((await step($, w, 1))?.model).toBe('claude-sonnet-5-5')
    expect(w.status.at(-1)).toBe(undefined)
  })

  test('bug 12: a subagent is judged fresh and routed against the active pick', async ($, on) => {
    const w = session(on, labels => labels[0]!, n => (n === 1 ? answered() : reply(lookup)))
    await $.prompt.submit({ text: NOTICE, ...composer })
    const r = await $.agent.spawn({ prompt: 'Find every call site of fetchUser and list them', subagentType: 'general-purpose', parentModel: 'claude-sonnet-5-5', fork: false, background: false } as never)
    expect(w.prompts[1]).not.toContain('Tier of the work so far')
    expect(w.prompts[1]).toContain('delegated')
    expect((r as { model?: string }).model).toBe('claude-opus-5-5')
    expect(await picks($, 'log')).toContain('1 subagents judged, 0 routed')
  })

  test('bug 13: entries go under the session\'s own key, and concurrent ones are all kept', async ($, on) => {
    const w = session(on, labels => labels.at(-1)!)
    await Promise.all([1, 2, 3].map(() => $.prompt.submit({ text: NOTICE, ...composer })))
    expect(await picks($, 'log')).toContain('3 prompts judged')
    expect([...w.store.keys()]).toEqual(['log:session-1'])
  })

  test('4.8: each entry carries session, turn, final tier, floor, limits and the judge facts', async ($, on) => {
    const w = session(on, labels => labels[0]!, () => reply({ ...deepCode, flags: [], tier: 'frontier' }))
    w.rows = [{ role: 'user', text: 'earlier prompt' }]
    await $.prompt.submit({ text: 'Rewrite the sync engine from scratch across every service.', ...composer })
    const [entry] = w.store.get('log:session-1') as Record<string, unknown>[]
    expect(entry).toMatchObject({
      session: 'session-1', turn: 2, tier: 'frontier', finalTier: 'deep', neverDown: false,
      risky: false, mechanical: false, limits: {},
    })
  })
})
