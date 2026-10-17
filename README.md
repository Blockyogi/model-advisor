# model-advisor

A Claude Code mod that checks each prompt before it runs and tells you when a different Claude model or effort level would do the job better, or for less of your plan.

Most of the time it stays quiet. When a change would help, it holds your prompt and asks:

```
Deep legal work: notice to an outside party. Weekly limit 42% used. Which setup should run it?

1  Best: Opus 5.5 · high
   Strongest on legal drafting and reasoning. About 2x the usage of Keep.
2  Balanced: same as Best
   Legal letters are never routed down to save usage.
3  Keep: Sonnet 5.5 · medium
   Fine for a draft you will review closely; weaker legal reasoning. No re-read.
```

Pick one and your prompt runs on it. Your pick stays in force until the next pick you accept, until you change the model or effort in the picker yourself, or until you type `/picks clear`.

## Install

You need Claude Code 2.1.294 or later. In a terminal session of Claude Code, type:

```
/plugin install model-advisor --marketplace Blockyogi/model-advisor
```

Answer `y` to add the marketplace, choose the user scope, and fill in the one setting (below). It then runs in every session, including the desktop app's Code tab.

## The setting: about your work

The judge reads one or two sentences about you to rate your prompts. For example:

> Indie iOS developer; also writes marketing copy and handles client contracts.

Leave it empty and the judge assumes a general mix of work. You can change it later with `/config`.

## Commands

| Command | What it does |
|---|---|
| `/picks` | Shows whether the advisor is on and what is running |
| `/picks clear` | Drops the advisor's pick; requests run on what the picker shows |
| `/picks off` / `/picks on` | Turns the advisor off or on for this session |
| `/picks log` | Shows recent judgments, what you chose, questions you dismissed and picks you overrode |

## How it decides

1. Claude Haiku 5.5, at low effort, reads your prompt and the last few turns and describes the work: light, standard, deep or frontier, plus flags such as "changes production", "a fix already failed" or "an outside audience reads it". It never sees model names.
2. Fixed rules in code turn that into Best and Balanced. Some of them:
   - Legal letters, tender submissions, production changes and debugging after a failed fix are never routed to a cheaper setup.
   - Mechanical work (installing a build, pushing, scheduling approved posts) is never upgraded.
   - Fable is offered only after an earlier attempt failed.
   - In a long conversation, a cheaper model has to pay back its one-time re-read within two prompts, so the advisor prefers an effort change.
   - Balanced gets cheaper as your weekly or 5-hour limit fills up.
3. It asks only when a change would really help. Small nudges, like Opus medium to Opus high, stay silent, except for work that is never routed down (legal letters, tenders, production changes, a failed fix).

If your prompt names its own setup in a line or sentence that starts with "Recommended" or "Model" (for example `Recommended: Opus 5.5 at high effort.` or `Model: Opus 5.5, high effort.`), that becomes Best, and the advisor's own lighter pick is offered as Balanced. A model named anywhere else is read as part of the request.

Subagents are routed without asking and without a judge call, since they start fresh and lose nothing by switching. Each goes by its type and the job its brief gives it:

- **Searches** (Explore, or a brief that says it is read-only): Haiku 5.5 at medium.
- **Reviews** (copy-reviewer, the Impeccable finish reviewer, or a read-only review or audit): Sonnet 5.5 at high. Haiku skips checks, and reviews exist to check.
- **Other work** (general-purpose agents that edit or write): the parent's model, at medium.
- **Inside a task that is never routed down** (legal, tenders, production changes, a failed fix): the parent's setup, whatever the job.

A call that names its own model or effort keeps it. Other agent types (design-critic and claude-code-guide, which name their own model; Plan; the editing agents of other plugins) run as their definition says.

## Good to know

- **The picker doesn't move.** A mod can't change the model picker in the desktop app, so after you accept a pick, a status line next to the picker shows what is really running, for example `running Opus 5.5 · high (undo: /picks clear)`.
- **Your prompts stay with you.** The judge runs through your own Claude Code sign-in; nothing is sent anywhere else. It costs about $1 a month of plan usage at heavy use.
- **It fails open.** If the judge is slow or errors, your prompt runs unchanged.
- **Headless runs are skipped.** Prompts in a `claude -p` run are not judged, since no one is there to answer.
- **The log holds no prompt text.** `/picks log` keeps the category, the picks and your choice, with the session id and prompt number, so you can see where the advisor over-asks.

## Remove it

```
/plugin uninstall model-advisor
```

## License

MIT
