import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteResult, On, SessionMessage, ToolCallInput, TurnStepInput } from 'claude-code'

const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
// The judge's facts (phase 4): what the work is, not how hard.
const facts = (v: object) => ({
  work: '', continuation: false, action: 'build', scope: 'few', novelty: 'known', checkable: true,
  flags: [], risky: false, domain: 'code', ongoing: true, ...v,
})
const deepLegal = JSON.stringify(facts({ work: 'legal notice to a builder', action: 'draft', scope: 'one', domain: 'legal', flags: ['outside_audience'] }))
const NOTICE = 'Draft the RERA legal notice to the builder for delayed possession.'
const composer = { wait: false, origin: { kind: 'composer' as const } }

const answered = (): ModelCompleteResult => ({ isAnswered: true, text: deepLegal, usage })
const reply = (v: object): ModelCompleteResult => ({ isAnswered: true, text: JSON.stringify(v), usage })

type World = {
  asked: string[][]; descriptions: string[][]; logs: string[]; toasts: string[]; status: (string | undefined)[]
  seen: TurnStepInput[]; judged: number; systems: string[]; prompts: string[]; agents: ToolCallInput[]
  model: string; rows: (Omit<SessionMessage, 'toolUses'> & { toolUses?: SessionMessage['toolUses'] })[]
  surfaces: string[]; store: Map<string, unknown>
}

// `answer` returns null to dismiss the question.
function session(
  on: On, answer: (labels: string[]) => string | null, judge: (n: number) => ModelCompleteResult = answered,
  env: Record<string, string> = { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
): World {
  const w: World = {
    asked: [], descriptions: [], logs: [], toasts: [], status: [], seen: [], judged: 0, systems: [], prompts: [], agents: [],
    model: 'claude-sonnet-5-5', rows: [], surfaces: ['desktop'], store: new Map(),
  }
  // The plugin's store, kept here so a test can read what was logged.
  on('store.get', (_$, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_$, e) => (w.store.set(e.key, JSON.parse(JSON.stringify(e.value))), { value: undefined }))
  on('store.delete', (_$, e) => (w.store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  mock.env(on, env)
  on('session.model', () => ({ value: w.model }))
  on('session.messages', () => ({ value: w.rows.map(r => ({ toolUses: [], ...r })) }))
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
  // The Agent call as it reaches the tool, after the plugin's rewrite.
  on('tool.call', { tool: 'Agent' }, (_$, e) => (w.agents.push(e), { deny: 'the test stops here' }))
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
  const deepCode = facts({ work: 'multi-file refactor', scope: 'many' })
  const push = facts({ work: 'git push', action: 'ship', scope: 'one' })
  const nextStep = facts({ work: 'next step', scope: 'one', continuation: true })

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
    expect(w.prompts[2]).toContain('The work so far was rated deep.')
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

  test('bug 13: entries go under the session\'s own key, and concurrent ones are all kept', async ($, on) => {
    const w = session(on, labels => labels.at(-1)!)
    await Promise.all([1, 2, 3].map(() => $.prompt.submit({ text: NOTICE, ...composer })))
    expect(await picks($, 'log')).toContain('3 prompts judged')
    expect([...w.store.keys()]).toEqual(['log:session-1'])
  })

  test('4.8: each entry carries session, turn, final tier, floor, limits and the judge facts', async ($, on) => {
    const w = session(on, labels => labels[0]!, () => reply({ ...deepCode, novelty: 'new' }))
    w.rows = [{ role: 'user', text: 'earlier prompt' }]
    await $.prompt.submit({ text: 'Rewrite the sync engine from scratch across every service.', ...composer })
    const [entry] = w.store.get('log:session-1') as Record<string, unknown>[]
    expect(entry).toMatchObject({
      session: 'session-1', turn: 2, finalTier: 'deep', action: 'build', scope: 'many', novelty: 'new', checkable: true,
      neverDown: false, risky: false, mechanical: false, limits: {},
    })
    expect(entry).not.toHaveProperty('tier')
    expect(entry).not.toHaveProperty('agreed')
  })
})

describe('v2 phase 2: subagents routed by type and job (section 4.6)', () => {
  const deepCode = reply(facts({ work: 'multi-file refactor', scope: 'many' }))
  const REFACTOR = 'Refactor the sync engine across the five services so retries are idempotent.'
  const SEARCH = 'Find every call site of fetchUser and list them with file and line.'
  const call = ($: Engine, subagentType: string | undefined, prompt: string, extra: Record<string, string> = {}) =>
    $.tool.call({ tool: 'Agent', description: 'a task', prompt, ...(subagentType ? { subagent_type: subagentType } : {}), ...extra } as never)
  const sent = (w: World) => {
    const a = w.agents.at(-1) as { model?: string; effort?: string } | undefined
    return [a?.model, a?.effort]
  }

  test('Explore runs on Haiku 5.5 at medium, with no judge call', async ($, on) => {
    const w = session(on, labels => labels[0]!)
    await call($, 'Explore', SEARCH)
    expect(sent(w)).toEqual(['haiku', 'medium'])
    expect(w.judged).toBe(0)
  })

  test('a general-purpose read-only search runs on Haiku 5.5 at medium', async ($, on) => {
    const w = session(on, labels => labels[0]!)
    await call($, undefined, 'Research task, read-only, no files to write. Find what changed in Claude Code 2.1.300.')
    expect(sent(w)).toEqual(['haiku', 'medium'])
  })

  test('reviewers that read and report run on Sonnet 5.5 at high', async ($, on) => {
    const w = session(on, labels => labels[0]!)
    await call($, 'copy-reviewer', 'Draft: /tmp/draft.md. Brand file: /tmp/brand.md.')
    expect(sent(w)).toEqual(['sonnet', 'high'])
    await call($, 'general-purpose', 'Read ~/.claude/agents/copy-reviewer.md, ignore its frontmatter, follow it exactly. Draft: /tmp/x.md')
    expect(sent(w)).toEqual(['sonnet', 'high'])
  })

  test('a general-purpose agent that edits keeps the parent model, at medium', async ($, on) => {
    const w = session(on, labels => labels[0]!, () => deepCode)
    await call($, 'general-purpose', REFACTOR)
    expect(sent(w)).toEqual([undefined, 'medium'])
    await $.prompt.submit({ text: REFACTOR, ...composer })
    expect(w.asked[0]![0]).toBe('Best: Opus 5.5 · high')
    await call($, 'general-purpose', REFACTOR)
    expect(sent(w)).toEqual(['opus', 'medium'])
  })

  test('inside a never-route-down task a subagent keeps the parent setup', async ($, on) => {
    const w = session(on, labels => labels[0]!)
    await $.prompt.submit({ text: NOTICE, ...composer })
    await call($, 'Explore', SEARCH)
    expect(sent(w)).toEqual(['opus', 'high'])
  })

  test('inside a never-route-down task with no pick, a subagent inherits the session as it is', async ($, on) => {
    const w = session(on, labels => labels.at(-1)!)
    await $.prompt.submit({ text: NOTICE, ...composer })
    await call($, 'copy-reviewer', 'Draft: /tmp/notice.md')
    expect(sent(w)).toEqual([undefined, undefined])
  })

  test('/clear ends the never-route-down task', async ($, on) => {
    const w = session(on, labels => labels.at(-1)!)
    await $.prompt.submit({ text: NOTICE, ...composer })
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await call($, 'Explore', SEARCH)
    expect(sent(w)).toEqual(['haiku', 'medium'])
  })

  test('a call that names its own model or effort is left as it is', async ($, on) => {
    const w = session(on, labels => labels[0]!)
    await call($, 'Explore', SEARCH, { model: 'sonnet' })
    expect(sent(w)).toEqual(['sonnet', undefined])
    await call($, 'Explore', SEARCH, { effort: 'low' })
    expect(sent(w)).toEqual([undefined, 'low'])
  })

  test('agent types with a model or job of their own are left as they are', async ($, on) => {
    const w = session(on, labels => labels[0]!)
    for (const t of ['design-critic', 'claude-code-guide', 'Plan', 'fork']) {
      await call($, t, SEARCH)
      expect(sent(w)).toEqual([undefined, undefined])
    }
  })

  test('/picks off leaves subagents as Claude Code sets them', async ($, on) => {
    const w = session(on, labels => labels[0]!)
    await picks($, 'off')
    await call($, 'Explore', SEARCH)
    expect(sent(w)).toEqual([undefined, undefined])
  })

  test('each route is logged and counted in /picks log', async ($, on) => {
    const w = session(on, labels => labels[0]!)
    await call($, 'Explore', SEARCH)
    const [row] = w.store.get('log:session-1') as Record<string, unknown>[]
    expect(row).toMatchObject({ kind: 'route', agent: 'Explore', job: 'search', model: 'haiku', effort: 'medium', session: 'session-1' })
    expect(await picks($, 'log')).toContain('1 subagents routed by type: 1 search, 0 review, 0 work, 0 kept on the parent')
  })
})

describe('v2 phase 4: two runs before a move down (4.5) and what the judge sees (4.2)', () => {
  const lookup = facts({ work: 'what HTTP 429 means', action: 'lookup', scope: 'one' })
  const opusSession = (w: World) => ((w.model = 'claude-opus-5-5'), w)

  test('a move down runs the judge a second time, and is offered when both runs agree', async ($, on) => {
    const w = opusSession(session(on, labels => labels.at(-1)!, () => reply(lookup)))
    await $.prompt.submit({ text: 'what does HTTP 429 mean', ...composer })
    expect(w.judged).toBe(2)
    expect(w.asked).toEqual([['Best: Sonnet 5.5 · low', 'Balanced: same as Best', 'Keep: Opus 5.5 · medium']])
    const [entry] = w.store.get('log:session-1') as Record<string, unknown>[]
    expect(entry).toMatchObject({ agreed: true, chosen: 'keep' })
  })

  test('when the second run disagrees the setup stays, with no question', async ($, on) => {
    const w = opusSession(session(on, labels => labels[0]!, n => reply(n === 1 ? lookup : facts({ scope: 'many' }))))
    await $.prompt.submit({ text: 'what does HTTP 429 mean', ...composer })
    expect(w.judged).toBe(2)
    expect(w.asked).toEqual([])
    const [entry] = w.store.get('log:session-1') as Record<string, unknown>[]
    expect(entry).toMatchObject({ agreed: false, held: 'the two runs disagree', chosen: 'silent' })
  })

  test('a failed second run holds the setup too', async ($, on) => {
    const w = opusSession(session(on, labels => labels[0]!, n => (n === 1 ? reply(lookup) : { isAnswered: false, reason: 'aborted', usage })))
    await $.prompt.submit({ text: 'what does HTTP 429 mean', ...composer })
    expect(w.asked).toEqual([])
  })

  test('a move up is asked about after one run', async ($, on) => {
    const w = session(on, labels => labels.at(-1)!)
    await $.prompt.submit({ text: NOTICE, ...composer })
    expect(w.judged).toBe(1)
  })

  test('the judge sees what the last turns did: tools, files edited and errors', async ($, on) => {
    const w = session(on, labels => labels.at(-1)!)
    w.rows = [
      { role: 'user', text: 'Add retries to the sync engine.' },
      {
        role: 'assistant', text: '', toolUses: [
          { tool_use_id: 'u1', tool: 'Edit', input: { file_path: '/repo/sync.ts' } },
          { tool_use_id: 'u2', tool: 'Bash', input: {}, isError: true },
        ],
      },
      { role: 'assistant', text: 'The CI test still fails. Want me to dig in?' },
    ]
    await $.prompt.submit({ text: NOTICE, ...composer })
    expect(w.prompts[0]).toContain('assistant did: tools Edit 1, Bash 1; edited sync.ts; errors: Bash 1')
    expect(w.prompts[0]).toContain("assistant's last message: The CI test still fails. Want me to dig in?")
  })
})
