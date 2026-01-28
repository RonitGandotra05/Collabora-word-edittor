# Collabora WordMeta & Speaker Identification System

This document describes the WordMeta feature (word-level highlighting via timestamps) and the Speaker Identification system. It covers the end-to-end flow from backend DOCX generation to frontend playback and hotkey interaction.

---

## 1. WordMeta System (Timestamps & Highlighting)

The system uses a **Hybrid Bookmark-Indexing** approach to achieve high-performance word highlighting during audio playback.

### 1.1 Backend Integration (Pre-Bookmarked DOCX)
The backend pre-processes the DOCX file before it reaches Collabora to embed word-level metadata directly into the document structure.

- **Source Code**: `backend/app/utils/docx_runs.py`
- **Mechanism**: The function `add_bookmarks_to_docx_sequential` walks through the document and wraps every word in a bookmark following the pattern `WMETA_<index>`.
- **Benefit**: This allows Collabora to "jump" to specific word indices instantly without needing to perform slow text searches during playback.

### 1.2 Collabora-side Changes (WordMeta Control)
- **File**: `browser/src/control/Control.WordMeta.js`
- **Bookmark Discovery**: On document load, Collabora requests all bookmarks starting with `WMETA_` using the `.uno:Bookmarks` command.
- **In-Memory Index**: It builds an in-memory index mapping word indices to these bookmarks.
- **Lazy Indexing**: If any words are missing bookmarks (e.g., words added manually in the editor), a background process indexes them by searching for the text and creating temporary bookmarks.

### 1.3 Highlighting Mechanism (Detailed Flow)
When the audio plays, the frontend synchronizes with Collabora through the following high-speed loop:

1. **Frontend Time Update**
   - The audio player fires `timeupdate` events (throttled to ~80ms).
   - The frontend sends a `Navigate_WordTime` PostMessage with the current audio timestamp (e.g., `{ time: 12.5 }`).

2. **Binary Search Lookup**
   - `Control.WordMeta.js` receives the timestamp.
   - It performs a **binary search** on the in-memory metadata array to find the word index corresponding to that time.
   - *Optimization*: It skips non-spoken tokens (speaker labels, timestamps) during this search.

3. **Bookmark Navigation**
   - Once the word index (e.g., `500`) is found, it retrieves the corresponding bookmark name (`WMETA_500`).
   - It executes `.uno:JumpToMark` with the bookmark name. This moves the internal cursor *immediately* to the start of that bookmark.

4. **Visual Selection**
   - After the jump, it executes `.uno:SelectWord`.
   - This command selects the word under the cursor, creating the blue selection highlight visible to the user.
   - *Prevention*: We disabled the fallback "text search" mechanism here. Previously, if `SelectWord` failed, it would search for the word text, but this caused *all* occurrences of common words (like "the") to highlight simultaneously. Now, it strictly relies on the precise bookmark location.

5. **Highlight Clearing**
   - Before highlighting a new word, `_clearHighlight()` is called to remove the previous selection.
   - This ensures only one word is highlighted at a time, creating a smooth "karaoke" effect.

---

## 2. Speaker Identification & Hotkey System

This system handles automatic speaker style detection and allows users to insert speaker names using hotkeys.

### 2.1 Auto Speaker Style Detection
When a document is opened, the editor automatically identifies the "Speaker Style" used.
- **Search-Based Detection**: It searches for colons (`:`) in the document.
- **Style Verification**: For each colon found, it inspects the paragraph style. If the style is not a "Default Paragraph Style", it's identified as the candidate Speaker Style (e.g., `'TCRA Colloquy'`).
- **Caching**: The detected style is cached in the frontend for subsequent speaker insertions.

### 2.2 Hotkey Mode & Interception
To allow rapid speaker insertion, a global hotkey interceptor is active when "Hotkey Mode" is enabled.
- **Document-Level Interceptor**: Added in `browser/src/map/handler/Map.WOPI.js`, this listener runs in the **capture phase**.
- **Early Interception**: It catches key presses (like '1', '2', etc.) before they reach the bundled `TextInput.js`.
- **Prevention**: It calls `preventDefault()` and `stopImmediatePropagation()` to ensure the hotkey character is NOT typed into the document.
- **PostMessage Trigger**: It fires a `Hotkey_Pressed` message to the frontend, which then executes the speaker insertion logic (splitting paragraphs, applying styles).

---

## 3. Communication API (PostMessages)

### 3.1 Frontend -> Collabora
| MessageId | Values | Purpose |
|-----------|-----------|---------|
| `Import_WordMeta` | `{ words: [...] }` | Imports transcript metadata and starts indexing. |
| `Navigate_WordTime` | `{ time: float }` | Navigates to the word at the given timestamp. |
| `Hotkey_Mode_Config` | `{ enabled: bool, hotkeys: [] }` | Enables/disables the hotkey interceptor. |
| `Capture_Speaker_Indent`| `{ wantAuto: bool }` | Triggers auto-detection of the speaker style. |

### 3.2 Collabora -> Frontend
| MessageId | Values | Purpose |
|-----------|-----------|---------|
| `WordMeta_IndexReady` | `{ wordCount: int, ... }` | Notifies that bookmark indexing is complete. |
| `Hotkey_Pressed` | `{ key: string }` | Notifies that a registered hotkey was intercepted. |
| `Speaker_Indent_Resp` | `{ style: string, ... }` | Returns the detected speaker style and margins. |

---

## 4. Rebuilding & Deployment

To apply changes made to the custom browser source files (like `Map.WOPI.js` or `Control.WordMeta.js`):

1. **Copy to Dist**:
   ```bash
   cp browser/src/map/handler/Map.WOPI.js browser/dist/src/map/handler/
   cp browser/src/control/Control.WordMeta.js browser/dist/src/control/
   ```
2. **Restart Container**:
   ```bash
   docker-compose restart collabora
   ```
3. **Hard Refresh**: Always perform a hard refresh (Cmd+Shift+R) in the browser to ensure the latest scripts are loaded.

For more detailed recovery and build instructions, see the `changes_by_ronit_documentation/REBUILD_DIST.md` file.
