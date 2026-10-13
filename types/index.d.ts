// The sticky choice: what turn.step applies to every main request until the
// next accepted pick, or until the person changes /model or effort themselves.
export type AdvisorActive = {
  model: 'haiku' | 'sonnet' | 'opus' | 'fable'
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  // what the session itself asked for when the pick took hold; null until the first request
  baseModel: string | null
  baseEffort: string | null
}

export type AdvisorTier = 'light' | 'standard' | 'deep' | 'frontier'

declare module 'claude-code' {
  interface PluginState {
    'model-advisor': {
      active: AdvisorActive | null
      previousTier: AdvisorTier | null
      isOff: boolean
      seenEffort: string | null
    }
  }
}
