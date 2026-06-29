# Debug Panel Prompt

Improve the NodeGLM Debug panel so it is a useful visual debugger for Pi code running in CppKAI.

The Debug tab must show at least three sub-panels at the same time. Do not hide them behind tabs.

1. Current State
   - Show the selected Executor's current Pi state in the same spirit as the Pi panel.
   - Include the current instruction/program position when available.
   - Show the data stack with stable top-to-bottom ordering and clear indexes.
   - Show selected Executor metadata: Executor id, Tree id, root id, scope, data stack size, and context stack size.
   - Keep step, continue, stack, clear, and refresh controls close to this panel.

2. Context
   - Show the selected Executor's context stack as its own panel.
   - Display each continuation/frame with its stack index, type/label, source text/value, and any available node id/path.
   - Make the top/current context visually distinct.
   - If a context entry represents a continuation that can be pasted into Pi, support double-click paste into the Pi panel.
   - Empty context must render as an explicit empty state, not as a blank box.

3. Console
   - Show trace and diagnostic output from KAI/CppKAI.
   - Include stdout, stderr, debug action responses, and trace messages in chronological order.
   - Preserve ANSI coloring through the existing `AnsiOutput` renderer where practical.
   - Provide a clear button for console output only.
   - Do not mix console traces into the Context panel.

Implementation constraints:

- Keep the existing WebSocket `/api/kai` bridge unless a backend change is necessary.
- Reuse the current `inspect_tree` and `debug_action` request flow where possible.
- If CppKAI does not currently expose enough context stack details, extend the backend/control response shape deliberately and add tests around the new fields.
- The Debug panel must update after every debug action that can change Executor state.
- Preserve the existing Tree panel behavior.
- The layout must be dense and debugger-like, not a marketing or landing-page layout.
- Avoid nested cards. Use a single debug workspace split into three visible regions.
- Text must not overflow buttons or compact panels at normal desktop widths.

Expected UI shape:

```text
Debug
+-----------------------+-----------------------+
| Current State         | Context               |
| Executor metadata     | context[0] current    |
| Data stack            | context[1]            |
| step continue stack   | ...                   |
+-----------------------+-----------------------+
| Console / Traces                              |
| stdout/stderr/debug trace output              |
+-----------------------------------------------+
```

Acceptance criteria:

- Opening the Debug tab shows Current State, Context, and Console panels at once.
- Selecting an Executor updates all three panels.
- Pressing step refreshes the displayed state and appends relevant trace output to Console.
- Pressing stack shows stack information without destroying prior trace output.
- Context stack entries are visible independently from the data stack.
- The Pi panel behavior is unchanged, including sending trailing backslashes directly to CppKAI.
- Add or update tests in `test/ui.test.js` and `test/kai-control.test.js` for the visible panel structure and any backend response changes.
- Run `npm test` and make it pass.
