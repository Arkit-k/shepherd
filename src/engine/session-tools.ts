// Board tools a launched session may use without stopping to ask. These only
// append to a local log and read it back, so prompting for each one turns a
// two-second join into a wall of dialogs.
//
// `spawn` is deliberately NOT here: a session that could open more sessions
// unprompted can do it recursively, and opening terminal windows is not
// something to grant silently. Asking once is the right cost.
export const SESSION_TOOLS = [
  "mcp__shepherd__join",
  "mcp__shepherd__share",
  "mcp__shepherd__board",
  "mcp__shepherd__ask",
  "mcp__shepherd__inbox",
  "mcp__shepherd__answer",
  "mcp__shepherd__said",
  "mcp__shepherd__scan",
];
