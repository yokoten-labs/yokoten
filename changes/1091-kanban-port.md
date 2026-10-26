Internal

The kanban area reaches outside code only through `src/commands/kanban/ports.ts`. Its other files import only each other, `src/platform/` and `node:` modules. A test fails on any other import, on `import()`, `require` or `node:child_process` in the area, and on a re-export in `ports.ts`. `KANBAN_PORTS` lists the old modules behind the port, and it only gets shorter (#1091).
