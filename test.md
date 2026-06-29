# Shepherd — test ledger (template)

_This is the canonical FORMAT for Shepherd's test memory. At runtime Shepherd
writes a per-project copy to `.shepherd/test.md` in whatever repo it is auditing.
It records every test Shepherd has designed or run, and — through the
`learnImportantTests()` function — distills from the conversation history and run
history **which tests matter most for this codebase, and why.**_

Shepherd's creed: **everything essential deserves a test.** This file is where it
keeps score and learns what "essential" means *here*.

---

## Tests done

_Appended automatically. One row per test Shepherd designed or executed._

| When | Kind | Target | Test | Result |
|------|------|--------|------|--------|
| _(none yet)_ | | | | |

Kinds: `unit` · `integration` · `contract` · `load` · `probe` (adversarial) · `regression`

---

## What matters here (learned)

_Distilled by `learnImportantTests()` from the conversation log (`user.md`) and the
run history. These are the test areas this team keeps caring about — the ones to
write first next time._

- _(nothing learned yet — run a few sessions, then ask Shepherd to "learn")_
