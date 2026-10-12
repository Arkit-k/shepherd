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

**3. Launch each session with a label:**

```bash
SHEPHERD_SESSION_LABEL=main   claude
SHEPHERD_SESSION_LABEL=intent claude
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
- **One machine, one folder.** Only `append()` and `read()` touch storage, so
  pointing them at a remote store would work across machines without changing a
  single tool. Not done.
- **Anyone on your board can put instructions into your agent.** Fine between
  sessions you own. Needs identity and an approval step before it is shared with
  another person.
