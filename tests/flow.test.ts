import { expect, mock, test } from 'claude-code/testing'
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

type World = {
  asked: string[][]; descriptions: string[][]; logs: string[]; toasts: string[]; status: (string | undefined)[]
  seen: TurnStepInput[]; judged: number; systems: string[]
}

function session(on: On, answer: (labels: string[]) => string, judge: () => ModelCompleteResult = answered): World {
  const w: World = { asked: [], descriptions: [], logs: [], toasts: [], status: [], seen: [], judged: 0, systems: [] }
  mock.store(on)
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.messages', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: 0 }, rateLimits: [] } }))
  on('settings.read', () => ({ value: { effortLevel: 'medium' } }))
  on('model.complete', (_$, e) => ((w.judged += 1), w.systems.push(e.system ?? ''), { value: judge() }))
  on('ui.status', (_$, e) => (w.status.push(e.text), { value: undefined }))
  on('ui.toast', (_$, e) => (w.toasts.push(e.text), { value: undefined }))
  on('ui.log', (_$, e) => (w.logs.push(e.text), { value: undefined }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const q = e.questions[0]!
    const labels = q.options.map(o => o.label)
    w.asked.push(labels)
    w.descriptions.push(q.options.map(o => o.description))
    return { result: { questions: e.questions, answers: { [q.question]: answer(labels) } } }
  })
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

test('/picks clear goes back to the picker', async ($, on) => {
  const w = session(on, labels => labels[0]!)
  on('command.run', () => ({ text: 'unanswered' }))
  await $.prompt.submit({ text: NOTICE, ...composer })
  await step($, w, 0)
  const out = await $.command.run({ command: 'picks', args: 'clear', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
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
