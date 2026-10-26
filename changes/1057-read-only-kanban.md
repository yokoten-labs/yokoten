Security

`yokoten kanban` is read only: its start, stop and limit buttons and their routes are gone, and any request but GET or HEAD gets a 405. The page reads one snapshot at `GET /api/state` and a session's live output at `GET /api/sessions/<id>/stream`; the id is a hash, never a path. `kanban --text` prints the same snapshot, with the state of main on Actions. The sign-in key goes only to the browser and is never printed (#1045, #1057).
