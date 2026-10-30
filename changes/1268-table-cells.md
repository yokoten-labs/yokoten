Fixed

An agent's name in a docs table, such as GitHub Copilot CLI, now stays on one line. On the docs site, a code span in a table cell stays whole, and a wide table scrolls instead. On a screen, an agent's name stays on one line too. `kanban --text` now shows an agent's full name on a line of its own instead of cutting it (#1268).

On `yokoten kanban --text`, a long agent name now stands whole on its own line, and the session rows have a blank line between them, as every screen with a wrapped row does.
