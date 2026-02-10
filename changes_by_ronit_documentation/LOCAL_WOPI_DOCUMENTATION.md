# Local WOPI Server — Electron Document Storage

## Overview

When running inside Electron, the application uses a **local WOPI server** to serve documents to Collabora Online instead of relying on the backend Flask WOPI server. This allows documents to be stored on the user's local disk in a hidden temporary directory, with a native export dialog for saving files to any location.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Electron App                             │
│                                                                 │
│  ┌──────────────┐    ┌───────────────┐    ┌──────────────────┐ │
│  │   Renderer    │    │  Main Process │    │  Local WOPI      │ │
│  │   (React)     │◄──►│  (electron.js)│◄──►│  Server (:9090)  │ │
│  │              │    │              │    │  (wopiServer.js) │ │
│  └──────┬───────┘    └───────┬──────┘    └────────┬─────────┘ │
│         │ IPC               │ fs                  │ HTTP       │
│         │                   ▼                     │            │
│         │         ┌────────────────┐              │            │
│         │         │  WOPI Temp Dir │              │            │
│         │         │  ~/Library/    │◄─────────────┘            │
│         │         │  Application   │                           │
│         │         │  Support/      │                           │
│         │         │  stenope.AI/   │                           │
│         │         │  wopi-temp/    │                           │
│         │         └────────────────┘                           │
└─────────┼─────────────────────────────────────────────────────┘
          │ iframe
          ▼
┌─────────────────────┐
│  Collabora Online   │
│  Docker (:9980)     │
│                     │
│  Reads/writes via   │
│  WOPI protocol to   │
│  localhost:9090     │
│  (host.docker.      │
│   internal:9090     │
│   from inside       │
│   Docker)           │
└─────────────────────┘
```

---

## Document Storage Locations

### Temporary Working Directory (Electron Only)

| Platform | Path |
|----------|------|
| **macOS** | `~/Library/Application Support/stenope.AI/wopi-temp/` |
| **Windows** | `%APPDATA%/stenope.AI/wopi-temp/` |
| **Linux** | `~/.config/stenope.AI/wopi-temp/` |

This directory is:
- **Hidden** from the user (inside app data)
- **Auto-created** on first use
- **Cleaned up** per document when a session closes (via `cleanupDocument()`)
- **Not user-facing** — users never browse or interact with this folder directly

### Backend Documents Directory

| Path | Purpose |
|------|---------|
| `backend/documents/` | Backend generates docx files here using `python-docx`. In Electron mode, these are copied to the WOPI temp dir and the backend copy remains as-is. |

---

## Complete Document Lifecycle

### Phase 1: Document Generation (Backend)

```
User clicks "Open in Editor"
         │
         ▼
Backend API: /api/transcript-editor
         │
         ├── Fetches transcript from MongoDB
         ├── Generates .docx using python-docx
         ├── Saves to backend/documents/{fileId}.docx
         ├── Generates WOPI access token
         └── Returns editor URL: /editor/{fileId}?speakers=...&title=...
```

**Files involved:**
- `backend/app/routes/api.py` — `transcript_editor()` endpoint
- `backend/app/routes/wopi.py` — WOPI token generation & metadata storage

### Phase 2: Document Transfer (Electron Main Process)

```
CollaboraEditorPage loads with fileId
         │
         ▼
isElectron() === true
         │
         ▼
fetchFromBackend(fileId)  ── IPC ──►  WOPI_FETCH_FROM_BACKEND handler
         │                                      │
         │                                      ├── Reads: backend/documents/{fileId}
         │                                      ├── Copies to: wopi-temp/{fileId}
         │                                      └── Returns { success: true, filePath }
         ▼
storeMetadataLocal(fileId, { speakers, title, sessionId })
         │
         ▼
Fetch editor config from local WOPI: http://localhost:9090/wopi/editor-config/{fileId}
```

**Files involved:**
- `frontend/src/pages/CollaboraEditorPage.js` — orchestrates the flow
- `frontend/src/services/electronWopi.js` — `fetchFromBackend()` service function
- `frontend/public/preload.js` — IPC bridge (`WOPI_FETCH_FROM_BACKEND`)
- `frontend/public/electron.js` — IPC handler (copies file on disk)

### Phase 3: Document Editing (Collabora ↔ Local WOPI)

```
Collabora iframe loads with WOPISrc
         │
         ▼
Collabora calls: GET http://host.docker.internal:9090/wopi/files/{fileId}
         │                    (CheckFileInfo — returns file metadata)
         ▼
Collabora calls: GET http://host.docker.internal:9090/wopi/files/{fileId}/contents
         │                    (GetFile — returns docx bytes from wopi-temp/)
         ▼
User edits document in Collabora
         │
         ▼
Collabora auto-saves: POST http://host.docker.internal:9090/wopi/files/{fileId}/contents
                              (PutFile — writes updated docx to wopi-temp/)
```

**Key detail:** Collabora runs inside Docker, so it accesses the WOPI server via `host.docker.internal:9090` (which maps to the host machine's `localhost:9090`). The WOPI server runs in Electron's main process.

**Files involved:**
- `frontend/public/wopiServer.js` — HTTP WOPI server implementation
  - `handleCheckFileInfo()` — returns file size, name, permissions
  - `handleGetFile()` — serves docx bytes
  - `handlePutFile()` — saves updated docx bytes
  - `handleEditorConfig()` — returns Collabora URL with WOPISrc

### Phase 4: Export (User Saves to Disk)

```
User clicks "Save" / "Export"
         │
         ▼
exportDocument(fileId, 'transcript.docx', 'docx')
         │
         ├── IPC: WOPI_EXPORT_DOCUMENT
         ├── Shows native OS save dialog
         ├── User picks location
         ├── Copies from wopi-temp/{fileId} → user's chosen path
         └── Returns { success: true, savedPath: '/Users/.../transcript.docx' }
```

**Files involved:**
- `frontend/src/services/electronWopi.js` — `exportDocument()` service function
- `frontend/public/electron.js` — `WOPI_EXPORT_DOCUMENT` IPC handler

### Phase 5: Cleanup (Session Closes)

```
User closes editor / navigates away
         │
         ▼
cleanupDocument(fileId)
         │
         ├── IPC: WOPI_CLEANUP_DOCUMENT
         ├── Deletes wopi-temp/{fileId}
         └── Returns { success: true }
```

**Files involved:**
- `frontend/src/services/electronWopi.js` — `cleanupDocument()` service function
- `frontend/public/electron.js` — `WOPI_CLEANUP_DOCUMENT` IPC handler

---

## File-by-File Reference

### `frontend/public/wopiServer.js`

The local WOPI HTTP server that runs in Electron's main process.

| Method | Description |
|--------|-------------|
| `startServer(port)` | Starts HTTP server on port 9090 |
| `handleCheckFileInfo(fileId, token)` | Returns file metadata (size, name, permissions) |
| `handleGetFile(fileId, token)` | Returns docx binary contents |
| `handlePutFile(fileId, token, body)` | Saves updated docx contents |
| `handleEditorConfig(fileId, params)` | Returns Collabora editor URL with WOPISrc |
| `generateToken(fileId)` | Creates WOPI access token |
| `saveDocument(fileId, buffer)` | Saves document buffer to temp dir |
| `deleteDocument(fileId)` | Deletes document from temp dir |
| `getFilePath(fileId)` | Returns absolute path in temp dir |
| `storeFileMetadata(fileId, metadata)` | Stores speaker/title metadata in memory |

### `frontend/public/electron.js` — WOPI IPC Handlers

| IPC Channel | Purpose |
|-------------|---------|
| `WOPI_SAVE_DOCUMENT` | Save document bytes to temp dir |
| `WOPI_DELETE_DOCUMENT` | Delete document from temp dir |
| `WOPI_DOCUMENT_EXISTS` | Check if document exists in temp dir |
| `WOPI_STORE_METADATA` | Store file metadata (speakers, title) |
| `WOPI_GET_URL` | Get WOPI URL and access token for Collabora |
| `WOPI_GET_DOCS_DIR` | Get temp documents directory path |
| `WOPI_FETCH_FROM_BACKEND` | Copy docx from backend/documents/ to temp dir |
| `WOPI_EXPORT_DOCUMENT` | Show native save dialog, copy to user's location |
| `WOPI_CLEANUP_DOCUMENT` | Delete temp document when session ends |

### `frontend/public/preload.js` — IPC Bridge

Exposes WOPI operations to the renderer via `window.electronAPI.wopi`:

```javascript
window.electronAPI.wopi.saveDocument(fileId, contentArray)
window.electronAPI.wopi.deleteDocument(fileId)
window.electronAPI.wopi.documentExists(fileId)
window.electronAPI.wopi.storeMetadata(fileId, metadata)
window.electronAPI.wopi.getWopiUrl(fileId, userId)
window.electronAPI.wopi.getDocsDir()
window.electronAPI.wopi.fetchFromBackend(fileId)
window.electronAPI.wopi.exportDocument(fileId, suggestedName, format)
window.electronAPI.wopi.cleanupDocument(fileId)
```

### `frontend/src/services/electronWopi.js` — Renderer Service

| Function | Description |
|----------|-------------|
| `isElectron()` | Returns true if running in Electron |
| `hasLocalWopi()` | Returns true if local WOPI API is available |
| `getWopiHostUrl()` | Returns `localhost:9090` (Electron) or backend URL (web) |
| `saveDocumentLocal(fileId, content)` | Save document bytes via IPC |
| `fetchFromBackend(fileId)` | Copy docx from backend to temp dir via IPC |
| `exportDocument(fileId, name, format)` | Show native save dialog via IPC |
| `cleanupDocument(fileId)` | Delete temp document via IPC |
| `storeMetadataLocal(fileId, metadata)` | Store metadata via IPC |

### `frontend/src/pages/CollaboraEditorPage.js`

The editor page orchestrates the full flow:

1. Detects Electron mode via `isElectron()`
2. Calls `fetchFromBackend(fileId)` to copy docx to temp dir
3. Stores metadata via `storeMetadataLocal()`
4. Fetches editor config from local WOPI server
5. Loads Collabora iframe with the config

---

## Docker Configuration

### `backend/collabora/docker-compose.yml`

```yaml
environment:
  - aliasgroup1=http://host.docker.internal:5001    # Backend Flask WOPI (web mode)
  - aliasgroup2=http://host.docker.internal:9090    # Local Electron WOPI server
  - extra_params=--o:ssl.enable=false
      --o:ssl.termination=false
      --o:storage.wopi.alias_groups[@mode]=groups   # Allow multiple WOPI hosts
```

**Key settings:**
- `aliasgroup1` — trusts the Flask backend WOPI server (for web mode)
- `aliasgroup2` — trusts the local Electron WOPI server (for Electron mode)
- `alias_groups[@mode]=groups` — enables multiple WOPI host groups (default `first` only allows one)
- `ssl.enable=false` — disables HTTPS (everything runs over HTTP locally)

---

## Web vs Electron Flow Comparison

| Step | Web (Chrome) | Electron |
|------|-------------|----------|
| Docx generation | Backend generates | Backend generates |
| Docx storage | `backend/documents/` | Copied to `wopi-temp/` |
| WOPI server | Flask on `:8000` | Node.js on `:9090` |
| WOPISrc | `http://host.docker.internal:5001` | `http://host.docker.internal:9090` |
| Collabora access | Direct HTTP | Docker → `host.docker.internal` |
| Save/Export | Browser download | Native OS save dialog |
| Auto-save | Backend WOPI handles | Local WOPI handles |
| Cleanup | Backend manages | Auto-deleted on session close |

---

## Security Notes

- The local WOPI server only binds to `127.0.0.1` (localhost) — not accessible from the network
- WOPI access tokens are generated per-file with expiration
- The temp directory is in the OS-designated app data folder (hidden from casual browsing)
- Collabora's `webSecurity` and `allowRunningInsecureContent` warnings are expected in dev mode and will not appear in packaged builds
- SSL is disabled for local development; production deployments should enable SSL

---

## Troubleshooting

### "Unauthorized WOPI host"
- Ensure `aliasgroup2=http://host.docker.internal:9090` is in docker-compose.yml
- Ensure `extra_params` includes `--o:storage.wopi.alias_groups[@mode]=groups`
- Restart Collabora container: `docker-compose down && docker-compose up -d`

### "File not found" (404 from WOPI)
- Check that `backend/documents/` contains the docx file
- Verify `WOPI_FETCH_FROM_BACKEND` copies it to `wopi-temp/`
- Check console for: `[CollaboraEditor] Copied to WOPI temp: ...`

### Electron binary missing
- Run: `node node_modules/electron/install.js`
- Then: `BROWSER=none npm run dev`

### Editor opens in Chrome instead of Electron
- Use `BROWSER=none npm run dev` to prevent React from opening Chrome
- The `electron.js` new-window handler keeps internal navigation inside Electron
