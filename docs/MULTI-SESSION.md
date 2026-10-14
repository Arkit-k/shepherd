# Multi-session board

Several Claude sessions, each with a human in it, sharing what they find — and
what the human says.

## Why this isn't Agent Teams

Claude Code ships **Agent Teams**: a lead session spawns teammates, they share a
task list and message each other. That is lead → worker, agent → agent, and
teammates never see the lead's conversation.

This is the other shape. Every session has a **human** in it, and the human's own
words are the shared context — captured by a `UserPromptSubmit` hook, not by a
model deciding to write something down. A session you are not talking to can see
what you asked for in a session you are.

That is the only thing here that nothing else does. Shared state and task
handoff already exist elsewhere.

## Setup

**1. Register the MCP server** (once):

```bash
claude mcp add -s user shepherd -- node /ABSOLUTE/PATH/shepherd/dist/mcp.js
```

**2. Install the hook** in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command",
          "command": "node /ABSOLUTE/PATH/shepherd/dist/hook.js" } ] }
    ]
  }
}
```

## Connecting sessions you already have open

You will not plan this in advance. You have four Claude sessions open across
four projects and *then* you want two of them talking to each other.

```bash
shepherd-connect            # tick sessions, connect them to the "default" board
shepherd-connect ship       # ... to a board called "ship"
shepherd-connect --status   # who is on what
shepherd-connect --disconnect
```

```
  Connect which sessions to board ship?

  ↑↓ move · space toggle · a all · enter confirm · esc cancel

  ❯ ◉ portfolio          ~/Projects/portfolio
    ◉ shepherd           ~/Projects/shepherd
    ◯ scratch            ~/Desktop/scratch       · on "default"
```

Ticked sessions are on the board from their next message. You do not have to tell
them anything, and they do not have to call `join`.

### How that is possible

Nothing can reach into a running interactive Claude session and make it run a
tool. There is no IPC for it and no injection.

It does not need one. The `UserPromptSubmit` hook is installed globally, so it is
**already firing in every Claude session on this machine** — every one of them is
already capturing prompts. They are unconnected only because `boardRoot()` sends
each one to a board derived from its own working directory.

So `connect` injects nothing. It writes `~/.shepherd/connect.json`, which maps a
session id to a board, and `boardRoot()` consults it. The plumbing already
existed; only the routing was wrong. The first prompt after ticking also appends
the session's `join` event, so it becomes a real addressable identity — it shows
up in `board` and you can `ask` it — without anyone calling the tool.

Sessions are keyed by **session id**, not directory, which is what lets two
sessions in the same folder sit on different boards, and stops a session changing
board because you `cd`'d.

## Launching a session already on a board

```bash
shepherd-session main ship    # new terminal, labelled "main", on board "ship"
shepherd-session --list       # boards and who is on them
```

The label is how other sessions address you and how your messages are attributed.
Without it, the working directory name is used.

## Tools

| tool | what it does |
|---|---|
| `join` | register under a label — rejoining resumes the same identity |
| `share` | publish a finding every session can read |
| `board` | who is active, what has been shared, what is outstanding |
| `ask` | ask another session for work, by label |
| `inbox` | requests addressed to you |
| `answer` | hand a result back |
| `said` | **what the human typed, across every session** |

## Watching it

`.shepherd/board/board.md` is rewritten on every event — keep it open in an
editor. Underneath is `.shepherd/board/events.jsonl`, append-only: stdio MCP
spawns one server process per session, so a mutable shared JSON file would lose
writes. Appends don't collide, and replaying the log gives the full audit trail.

## Limits, honestly

- **Pull, not interrupt.** `ask` records a request; the other session sees it when
  it calls `inbox`. Nothing yanks a session mid-thought.
- **Connecting routes future prompts.** What a session said before you ticked it
  stays where it was. Nothing is deleted; it just stops writing there, and
  `connect` prints what moved.
- **Discovery sees live processes only.** Read from Claude Code's own registry at
  `~/.claude/sessions/*.json`. `--status` marks sessions that have exited and
  `--prune` clears them.
- **`--fork-session` mints a new session id**, so a forked session arrives
  unconnected and has to be ticked again. A plain `--resume` keeps its id and
  stays connected.
- **One machine.** Only `append()` and `read()` touch storage, so pointing them at
  a remote store would work across machines without changing a single tool. Not
  done.
- **Anyone on your board can put instructions into your agent.** Fine between
  sessions you own. Needs identity and an approval step before it is shared with
  another person.
