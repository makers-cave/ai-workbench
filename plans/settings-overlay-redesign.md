# Settings Overlay Redesign — Plan

## Goal
Replace the current single-section settings overlay with a tabbed layout in the
style of Visual Studio's Project Properties window. Two top-level sections are
required:

- **General** — existing dashboard preferences (theme, hub host/port, auto-refresh)
- **Tools** — full per-tool management: show/hide on dashboard, install from a
  remote zip URL, upload a local zip (new folder or replace existing), and
  delete (tool files, optionally also its data directory).

## Decisions (confirmed with user)
- Tool visibility is persisted **server-side** in `data/settings.json` (a small
  JSON file the server reads/writes). This keeps the dashboard view consistent
  across browsers/users on the same host.
- "Download from remote server" means **fetch a zip URL** on the server and
  extract it into `tools/<id>/`.
- "Upload zip" supports both **a brand-new folder** and **replacing the contents
  of an existing folder**.
- "Delete" removes `tools/<id>/` and, when an explicit toggle is enabled, also
  removes `data/<id>/`.

## Visual layout

```
+--------------------------------------------------------------+
|  Settings                                                  X  |
+--------------------------------------------------------------+
|              |                                              |
|  General     |   [ General panel content ]                   |
|              |   - Theme                                     |
|  Tools       |   - Hub host                                  |
|              |   - Hub port                                  |
|              |   - Auto-refresh interval                     |
|              |   - About blurb                               |
|              |                                              |
|              |   -- OR (when Tools tab active) --            |
|              |                                              |
|              |   + Add tool                                  |
|              |   [ Install from URL ]   [ Upload zip ]       |
|              |                                              |
|              |   Available tools                             |
|              |   +-----------------------------------+       |
|              |   | icon  Tool name   status   [actions]|     |
|              |   +-----------------------------------+       |
|              |   ... rows ...                                |
|              |                                              |
+--------------------------------------------------------------+
|  Reset to defaults                       Cancel   Save       |
+--------------------------------------------------------------+
```

- Left rail = vertical tab list. Active tab is highlighted with a left accent
  bar and a subtle background. Hover state gives feedback.
- Right pane = the active panel. Tools panel scrolls independently.
- Footer stays the same (Reset / Save) so we don't change the save contract for
  General preferences. The Tools panel writes immediately via dedicated
  endpoints (no Save needed for tool actions), matching how file-management
  dialogs usually work.

## Files to change

1. [`server.py`](server.py:36) — add settings store + install/upload/delete
   helpers; pass them into the handler.
2. [`routes.py`](routes.py:87) — extend the dispatcher with new routes.
3. [`html/index.html`](html/index.html:39) — replace the settings overlay body.
4. [`css/style.css`](css/style.css:51) — replace/extend `.settings-*` styles.
5. [`js/app.js`](js/app.js:41) — replace the settings JS block.
6. NEW: [`data/settings.json`](data/.gitkeep) (auto-created on first run, gitkeep
   stays so the directory exists).

## Server-side design

### Settings store (new module-style block in `server.py`)
- Path: `data/settings.json`
- Schema:
  ```json
  {
    "hidden_tools": ["stable-diffusion", "openwebui"],
    "ui": { "theme": "dark" }
  }
  ```
- Helpers:
  - `load_settings()` — read with default fallback, atomic-ish write via
    `.tmp` + rename.
  - `save_settings(d)` — write JSON, ensure `data/` exists.
- `tools()` (already exists) gets filtered: any tool whose `_id` is in
  `hidden_tools` is omitted from the dashboard list. The Tools panel still
  needs hidden items to display them as "hidden" with a "Show" button — for
  that, expose a separate `all_tools()` (or just always pass the unfiltered list
  to the settings endpoint).

### New endpoints (all in [`routes.py`](routes.py:104))
| Method | Path                              | Purpose                                                     |
|-------:|-----------------------------------|-------------------------------------------------------------|
| GET    | `/api/settings`                   | Return current `data/settings.json` (hidden_tools + ui)     |
| PUT    | `/api/settings`                   | Replace settings file (used for General prefs + visibility) |
| GET    | `/api/settings/tools`             | List ALL tools including hidden ones, with status           |
| POST   | `/api/tools/install`              | JSON body `{id, url}` — fetch zip, extract to `tools/<id>`  |
| POST   | `/api/tools/upload`               | multipart form `id, mode=new\|replace, file` — extract zip   |
| POST   | `/api/tools/{id}/visibility`      | JSON `{hidden: true/false}` — toggle in settings.json       |
| DELETE | `/api/tools/{id}?delete_data=1`   | Remove `tools/<id>/` (and `data/<id>/` if flag set)         |

### Long-running ops go through background tasks
- Install and Upload can take time (network, extraction, large zips). Reuse the
  existing background-task machinery in [`server.py`](server.py:49):
  - Generate a `task_id`, register in `_background_tasks`, run a worker thread
    that fetches/extracts and updates the task record.
  - Return `{ok: true, output: "Task ID: <uuid>"}` on start so the frontend can
    poll `/api/tools/{id}/task/{task_id}` like existing enable/disable flows.
- For Upload we need a `temp` staging dir since the body is multipart; write
  the upload to `data/.uploads/<task_id>.zip`, then extract, then delete the
  zip. Use `python -c` or stdlib `zipfile` to extract — no shell dep.

### Safety rails
- Validate `id` against `^[a-z0-9_-]{1,40}$` everywhere a path is built. Refuse
  anything else (prevents path traversal).
- Refuse install into an existing `tools/<id>` unless `mode=replace` is
  confirmed by the client (and we expose a confirm toggle in the UI).
- Size-limit uploads (e.g. 500 MB) using `Content-Length` header check before
  buffering to disk.
- Run zip extraction with `zipfile` after verifying the zip is a real zip
  (`zipfile.is_zipfile`).

## Frontend design

### HTML ([`html/index.html`](html/index.html:39))
- New overlay skeleton:
  ```
  .settings-overlay
    .settings-card.settings-card--wide
      .settings-head
        h2 Settings
        button#settings-close
      .settings-body.settings-body--tabs
        nav.settings-tabs(role="tablist")
          button[role=tab]#tab-general (aria-selected)
          button[role=tab]#tab-tools
        .settings-panes
          section[role=tabpanel]#pane-general
            ... existing rows ...
          section[role=tabpanel]#pane-tools(hidden)
            .tools-actions
              button#tool-install-url  Install from URL
              button#tool-upload-zip   Upload zip
              input#tool-upload-file(type=file,hidden)
            ul#tools-list
      .settings-foot
        button#settings-reset
        button#settings-save
  ```
- The Tools pane lists each tool with:
  - icon, name, status badge
  - toggle switch (Show / Hide on dashboard)
  - **Delete** button (opens a small inline confirm with a "Also delete
    `data/<id>/`" checkbox).

### CSS ([`css/style.css`](css/style.css:51))
- Widen the card to ~720px, set a fixed grid for rail/pane:
  ```css
  .settings-card--wide{ width:min(720px,100%); grid-template-columns:160px 1fr; display:grid; ... }
  .settings-tabs{ display:flex; flex-direction:column; border-right:1px solid #29334d; }
  .settings-tabs button{ text-align:left; padding:10px 14px; background:none; border:0; color:#cfd6ea; cursor:pointer; border-left:3px solid transparent; }
  .settings-tabs button[aria-selected=true]{ background:#16203a; border-left-color:#2b6cff; color:#fff; }
  .settings-panes{ padding:18px 20px; overflow:auto; max-height:70vh; }
  ```
- Tool row styles: a flex card with subtle background, status pill, and a
  three-button action group (toggle switch, delete). Add `.tool-row.hidden`
  dimmed style for clarity (the row is on the dashboard, just hidden).

### JS ([`js/app.js`](js/app.js:41))
- Replace the existing settings block with a small module-style object:
  - `state.settings = { general, hiddenTools }` loaded on open.
  - `openSettings()` fetches `/api/settings` + `/api/settings/tools`,
    populates both panes, activates the last-used tab (default General).
  - `selectTab(name)` toggles `aria-selected` and shows/hides panes.
  - **General** save path is preserved: Save button writes `ui` keys to
    `/api/settings` via PUT.
  - **Tools** actions are immediate:
    - Hide toggle -> `POST /api/tools/{id}/visibility`.
    - Install from URL -> small inline form (id + url) ->
      `POST /api/tools/install` with `{id,url}`; log output to sidebar using
      the existing background-task poller.
    - Upload zip -> hidden file input. On choose, prompt for `id` and mode
      (new vs replace); submit as multipart; poll task.
    - Delete -> inline confirm row + "also delete data" checkbox ->
      `DELETE /api/tools/{id}?delete_data=1`.
  - After any successful install/upload/delete, re-fetch
    `/api/settings/tools` and re-render the list, plus call `load()` to refresh
    the dashboard grid.

### Reset behavior
- "Reset to defaults" only affects the General pane (theme/host/port/refresh)
  and resets `hidden_tools` to `[]`. Tool files on disk are NOT touched by
  Reset (deletes require the explicit Delete action).

## Backwards compatibility
- The four General fields keep their old localStorage keys for users who never
  touch Settings again (no migration needed; first save migrates them to the
  server file via the existing Save button).
- Old `/api/tools` payload is unchanged; hidden tools are simply omitted.
- Old `enable`/`disable` POST routes are unchanged.

## Verification checklist (manual)
1. Open Settings -> General tab shows existing fields.
2. Switch to Tools tab -> every tool in `tools/` is listed with current state.
3. Toggle Hide on "Open WebUI" -> row dims, dashboard grid no longer shows it.
4. Install from URL with a small public zip -> new folder appears in `tools/`
   and the row appears in the Tools pane (and on the dashboard after refresh).
5. Upload a local zip into a NEW id -> same as #4 but with a local file.
6. Upload into an EXISTING id after confirming replace -> contents overwritten.
7. Delete a tool with the "also delete data" checkbox off -> only `tools/<id>`
   removed; `data/<id>` survives.
8. Delete with the toggle on -> both removed; dashboard updates.
9. Reset to defaults -> theme/host/port/refresh reset, hidden_tools cleared,
   but installed/deleted tools on disk are untouched.
10. Escape / overlay click / X still close the overlay.

## Open assumptions (called out so the reviewer can correct them)
- "Install from URL" only supports zip archives (not tar.gz). Confirm if you
  want tar.gz support as well.
- Upload limit of 500 MB and zip-only uploads.
- `data/settings.json` is created with `chmod 644`; on multi-user hosts the
  web user must own it. We create it on first write using the same UID the
  server runs as, which matches the existing model.
