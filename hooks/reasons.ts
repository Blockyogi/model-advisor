// The words in the question: one line of reasoning under each of Best,
// Balanced and Keep, drawn from the research task map (section 3).

import type { Domain, Verdict } from './judge'
import { label, weight, type Decision, type Limits, type Setup } from './picks'

export type Row = { label: string; description: string; choice: 'best' | 'balanced' | 'keep' }

const OPUS_FOR: Partial<Record<Domain, string>> = {
  legal: 'Strongest on legal drafting and reasoning',
  tender: 'Strongest on long, rule-bound documents like tenders',
  code: 'Best at multi-file code and bugs with unknown causes',
  ios: 'Best at multi-file app code and unknown bugs',
  finance: 'Strongest on finance analysis and conclusions',
  research: 'Most reliable on factual research, fewest invented figures',
  ledger: 'Best when the numbers must reconcile',
  copy: 'Strong prose; effort adds little for writing',
}
const SONNET_FOR: Partial<Record<Domain, string>> = {
  website: 'Top-rated for building websites',
  spreadsheet: 'Rated best for building and cleaning spreadsheets',
}
const WEAKER_ON: Partial<Record<Domain, string>> = {
  legal: 'weaker legal reasoning',
  tender: 'weaker on long rule-bound documents',
  code: 'weaker on multi-file code',
  ios: 'weaker on multi-file app code',
  finance: 'weaker finance analysis',
  research: 'less reliable on facts and figures',
  ledger: 'less reliable when numbers must tie out',
}

function strength(s: Setup, v: Verdict): string {
  if (v.risky && (s.model === 'opus' || s.model === 'fable')) return 'Most careful with acts that change live systems, money or data'
  if (s.model === 'haiku') return 'Fast and very light on your limit, for one-step mechanical work'
  if (s.model === 'fable') return 'Deepest model, for long jobs where errors compound; drains your limit fastest'
  if (s.model === 'sonnet') return SONNET_FOR[v.domain] ?? 'Fast and capable for routine, well-specified work'
  if (s.effort === 'xhigh' || s.effort === 'max') return 'Extra reasoning for a problem whose cause is unknown'
  return OPUS_FOR[v.domain] ?? "Anthropic's recommended default for most work"
}

function usageVs(pick: Setup, other: Setup, otherName: string): string {
  const r = weight(pick) / weight(other)
  if (r > 1.15) return `about ${r < 1.95 ? r.toFixed(1) : Math.round(r)}x the usage of ${otherName}`
  if (r < 0.85) return `about ${Math.round((1 - r) * 100)}% less usage than ${otherName}`
  return `about the same usage as ${otherName}`
}

function switchNote(pick: Setup, current: Setup, contextTokens: number, isFirstPrompt: boolean): string {
  if (pick.model === current.model) return pick.effort === current.effort ? '' : 'Effort change only, no re-read.'
  if (isFirstPrompt || contextTokens < 50_000) return 'Nothing to re-read yet.'
  return `Re-reads the ${Math.round(contextTokens / 1000)}K-token conversation once.`
}

function whyNotLower(d: Decision, v: Verdict, isStated: boolean): string {
  if (isStated) return 'Your prompt names this setup.'
  if (v.domain === 'legal') return 'Legal letters are never routed down to save usage.'
  if (v.domain === 'tender') return 'Tender submissions are never routed down.'
  if (v.risky) return 'It changes production, money or data, so it is never routed down.'
  if (v.flags.includes('failed_before') || d.steppedUp) return 'A fix already failed, so it is not routed down.'
  if (v.domain === 'copy' && v.flags.includes('outside_audience')) return 'Final public copy is never routed down.'
  if (d.neverDown) return 'Work like this is never routed down.'
  if (d.held) return `Not sure enough to go lower (${d.held}).`
  return 'No cheaper setup holds up for this work.'
}

const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
const same = (a: Setup, b: Setup) => a.model === b.model && a.effort === b.effort

export function questionText(d: Decision, v: Verdict, limits: Limits): string {
  const tier = sentence(d.tier)
  const why = d.why.replace(/[.\s]+$/, '')
  const weekly = limits.weekly === undefined ? '' : ` Weekly limit ${Math.round(limits.weekly)}% used.`
  const failed = d.steppedUp ? ' The last attempt fell short.' : ''
  return `${tier} ${v.domain === 'other' ? '' : `${v.domain} `}work${why ? `: ${why}` : ''}.${failed}${weekly} Which setup should run it?`
}

export function rows(
  d: Decision, v: Verdict, current: Setup, ctx: { contextTokens: number; isFirstPrompt: boolean; limits: Limits; isStated: boolean },
): Row[] {
  const note = (pick: Setup) => switchNote(pick, current, ctx.contextTokens, ctx.isFirstPrompt)
  const join = (...parts: string[]) => parts.filter(Boolean).join('. ').replace(/\.\./g, '.')

  const best: Row = same(d.best, current)
    ? { label: 'Best: same as Keep', description: 'Your current setup already fits this work.', choice: 'keep' }
    : {
        label: `Best: ${label(d.best)}`,
        description: join(ctx.isStated ? 'Your prompt names this setup' : strength(d.best, v), sentence(usageVs(d.best, current, 'Keep')), note(d.best)),
        choice: 'best',
      }

  const tight = (ctx.limits.weekly ?? 0) >= 80 || (ctx.limits.fiveHour ?? 0) >= 85
  const balanced: Row = same(d.balanced, d.best)
    ? { label: 'Balanced: same as Best', description: whyNotLower(d, v, ctx.isStated), choice: 'best' }
    : same(d.balanced, current)
      ? { label: 'Balanced: same as Keep', description: ctx.isStated ? `The advisor's own pick for this work: ${d.why.replace(/[.\s]+$/, '')}.` : 'Your current setup is already the economical choice here.', choice: 'keep' }
      : {
          label: `Balanced: ${label(d.balanced)}`,
          description: join(
            sentence(usageVs(d.balanced, d.best, 'Best')),
            tight ? 'Cheaper because your plan limit is running low' : strength(d.balanced, v),
            note(d.balanced),
          ),
          choice: 'balanced',
        }

  const keepWhy = weight(current) < weight(d.best)
    ? current.model === 'haiku'
      ? 'May skip checks on work like this'
      : current.model === d.best.model
        ? 'Less reasoning than this work usually needs'
        : `Fine for a draft you will review closely; ${WEAKER_ON[v.domain] ?? 'less depth than Best'}`
    : weight(current) > weight(d.best)
      ? `More than this work needs: ${usageVs(current, d.best, 'Best')}`
      : 'Stays as you are'
  const keep: Row = { label: `Keep: ${label(current)}`, description: join(keepWhy, 'No re-read.'), choice: 'keep' }

  return [best, balanced, keep]
}
