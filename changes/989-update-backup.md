Fixed

`yokoten update --write` now keeps the old AGENTS.md as `AGENTS.md.before-yokoten` when git cannot give it back. It never overwrites an existing copy. It refuses an AGENTS.md that is a link, as `yokoten init` does (#989).
