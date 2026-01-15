# Collabora WordMeta Changes (This Repo)

This document summarizes the WordMeta feature changes added in this repo and how the
frontend should communicate with Collabora.

---

## 1) Collabora-side changes

### 1.1 WordMeta control

File: `browser/src/control/Control.WordMeta.js`

Added a new control that:
- Stores word metadata in memory.
- Supports time-based lookup (binary search).
- Creates and manages bookmarks (`WMETA_<index>`).
- Highlights words by navigating to a bookmark and selecting via search.
- Runs background indexing in batches to avoid UI lag.

Key behaviors:
- Importing metadata kicks off background indexing.
- Bookmark names are `WMETA_<index>` (0-based).
- If a bookmark is missing for a word, that word is not highlighted.

### 1.2 PostMessage handlers

File: `browser/src/map/handler/Map.WOPI.js`

Handlers added:
- `Import_WordMeta` -> import and start indexing
- `Get_WordMeta` -> fetch word metadata by index
- `Navigate_WordTime` -> find word by timestamp and navigate

Each handler posts a response to the parent window with `*_Resp`.

### 1.3 Plugin initialization

File: `browser/src/app/ServerConnectionService.ts`

On document load, the WordMeta control is created and added to the map
(if it is not already present).

### 1.4 Build inclusion

File: `browser/Makefile.am`

`Control.WordMeta.js` is included in the browser bundle list.

### 1.5 Bookmark reuse (pre-bookmarked DOCX)

Files:
- `browser/src/control/Control.WordMeta.js`
- `browser/src/layer/tile/WriterTileLayer.js`

If the DOCX already contains bookmarks with the `WMETA_` prefix, Collabora reuses
those and only indexes missing words. Bookmark discovery is done by requesting:

```
commandvalues command=.uno:Bookmarks?namePrefix=WMETA_
```

`WriterTileLayer` routes the bookmark results to WordMeta (when present).

---

## 2) Highlighting behavior

Current behavior:
- If a word has a bookmark, Collabora:
  1) Jumps to the bookmark (`.uno:JumpToMark`).
  2) Tries to select the word at the cursor (`.uno:SelectWord`).
  3) If no selection appears, runs a bounded search for that word from the cursor.
- If a word does not have a bookmark, the selection highlight is cleared and
  the word is left unhighlighted.

Notes:
- This uses the selection highlight (search result selection), not formatting.
- Background indexing is paused during highlight search to avoid interfering
  with the indexing search sequence.

---

## 3) Background indexing details

Indexing runs in batches and is safe for large word lists.
When indexing finishes, Collabora sends a `WordMeta_IndexReady` postMessage.

Tunable parameters (in `Control.WordMeta.js`):
- `batchSize = 50`
- `batchDelayMs = 10`
- `searchTimeoutMs = 1500`
- `highlightDebounceMs = 80`
- `highlightJumpDelayMs = 60`
- `highlightSearchTimeoutMs = 800`

---

## 4) Frontend <-> Collabora communication

### 4.1 Required origin setup

In WOPI `CheckFileInfo`, set the parent origin:

```
PostMessageOrigin = http://localhost:3000
```

In the Collabora iframe URL, include:

```
postMessageOrigin=http%3A%2F%2Flocalhost%3A3000
```

The parent sends postMessage **to the Collabora origin** (e.g. `http://localhost:9980`).

### 4.2 Commands (Frontend -> Collabora)

Import word metadata:

```json
{
  "MessageId": "Import_WordMeta",
  "Values": {
    "words": [
      { "word": "Hello", "start": 0.0, "end": 0.52, "confidence": 0.98 }
    ]
  }
}
```

Navigate by time:

```json
{
  "MessageId": "Navigate_WordTime",
  "Values": { "time": 12.34 }
}
```

Get metadata for a word:

```json
{
  "MessageId": "Get_WordMeta",
  "Values": { "index": 0 }
}
```

### 4.3 Responses (Collabora -> Frontend)

```json
{
  "MessageId": "Import_WordMeta_Resp",
  "Values": { "success": true, "wordCount": 1234 }
}
```

```json
{
  "MessageId": "Navigate_WordTime_Resp",
  "Values": {
    "time": 12.34,
    "wordIndex": 456,
    "found": true,
    "hasBookmark": true
  }
}
```

```json
{
  "MessageId": "Get_WordMeta_Resp",
  "Values": { "index": 0, "metadata": { "word": "Hello", "start": 0.0, "end": 0.52 } }
}
```

Indexing complete notification:

```json
{
  "MessageId": "WordMeta_IndexReady",
  "Values": { "wordCount": 1234, "indexedCount": 1234, "missingCount": 0 }
}
```

### 4.4 Frontend postMessage example

```js
const msg = {
  MessageId: 'Import_WordMeta',
  Values: { words }
};
iframe.contentWindow.postMessage(JSON.stringify(msg), 'http://localhost:9980');
```

---

## 5) Runtime debugging

In the Collabora iframe console:

```
app.map.wordMeta.isLoaded()
app.map.wordMeta.getWordCount()
```

In the parent window:

```
window.addEventListener('message', (e) => console.log('MSG:', e.data));
```

Docker logs (Collabora container):

```
docker logs -f <collabora_container_name>
```

If you use docker-compose:

```
docker compose logs -f <service_name>
```

Note: WordMeta logs are emitted from the browser client (iframe), so they will
appear in the browser console. Use Docker logs for server-side Collabora output.

---

## 6) Known limitations

- Bookmark creation is sequential and search-based; if transcript text does not
  match the document, some words may not be mapped.
- Highlighting relies on selection, not a persistent highlight style.
- Selection uses `.uno:SelectWord` with a search fallback; if selection is blocked
  by focus changes, highlight may still fail.
# WordMeta Frontend Playback Integration

This document describes how the frontend should communicate with the Collabora WordMeta
integration to achieve audio playback with word-level highlighting.

---

## 1) Overview

Flow:
1) Load Collabora iframe with the correct `postMessageOrigin`.
2) Wait for Collabora to report `Document_Loaded`.
3) Send `Import_WordMeta` with the transcript word array.
4) Wait for `WordMeta_IndexReady` before starting playback.
5) On audio time updates, send `Navigate_WordTime`.
6) Listen to `Navigate_WordTime_Resp` for diagnostics.

---

## 2) Required origin setup

### 2.1 WOPI CheckFileInfo

Your WOPI `CheckFileInfo` must include the parent origin:

```
PostMessageOrigin = http://localhost:3000
```

### 2.2 Collabora iframe URL

Include the same origin encoded in the iframe URL:

```
postMessageOrigin=http%3A%2F%2Flocalhost%3A3000
```

### 2.3 postMessage target origin

The parent should always post messages to the **Collabora origin** (not the parent origin):

```
http://localhost:9980
```

---

## 3) Data contract (what Collabora expects)

### 3.1 Import_WordMeta payload

- `MessageId`: `Import_WordMeta`
- `Values.words`: array of word objects

Each word object must follow:
- `word`: string (text of the word)
- `start`: number (seconds, float)
- `end`: number (seconds, float)
- `confidence`: number (0.0–1.0)

Example:

```json
{
  "MessageId": "Import_WordMeta",
  "Values": {
    "words": [
      { "word": "Hello", "start": 0.0, "end": 0.52, "confidence": 0.98 },
      { "word": "world", "start": 0.55, "end": 1.02, "confidence": 0.95 }
    ]
  }
}
```

### 3.2 Navigate_WordTime payload

- `MessageId`: `Navigate_WordTime`
- `Values.time`: number (seconds)

Example:

```json
{
  "MessageId": "Navigate_WordTime",
  "Values": { "time": 12.34 }
}
```

### 3.3 Get_WordMeta payload

- `MessageId`: `Get_WordMeta`
- `Values.index`: number (0-based index)

Example:

```json
{
  "MessageId": "Get_WordMeta",
  "Values": { "index": 0 }
}
```

---

## 4) Responses from Collabora

### 4.1 Import_WordMeta_Resp

Indicates metadata import succeeded and reports word count.

```json
{
  "MessageId": "Import_WordMeta_Resp",
  "Values": { "success": true, "wordCount": 1234 }
}
```

### 4.2 WordMeta_IndexReady

Sent when background bookmark indexing is complete.

```json
{
  "MessageId": "WordMeta_IndexReady",
  "Values": { "wordCount": 1234, "indexedCount": 1234, "missingCount": 0 }
}
```

You should gate playback until this arrives.

### 4.3 Navigate_WordTime_Resp

Reports lookup results and whether the word has a bookmark.

```json
{
  "MessageId": "Navigate_WordTime_Resp",
  "Values": {
    "time": 12.34,
    "wordIndex": 456,
    "found": true,
    "hasBookmark": true
  }
}
```

Use this response to log missing mappings (`found=false` or `hasBookmark=false`).

### 4.4 Get_WordMeta_Resp

```json
{
  "MessageId": "Get_WordMeta_Resp",
  "Values": { "index": 0, "metadata": { "word": "Hello", "start": 0.0, "end": 0.52 } }
}
```

---

## 5) Frontend playback implementation (example)

### 5.1 Basic setup

```js
const collaboraOrigin = 'http://localhost:9980';
const iframe = document.getElementById('collabora-frame');
const audio = document.getElementById('audio');

let collaboraReady = false;
let indexReady = false;
let currentWordIndex = -1;

window.addEventListener('message', (event) => {
  let msg;
  try {
    msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
  } catch {
    return;
  }

  switch (msg.MessageId) {
    case 'App_LoadingStatus':
      if (msg.Values?.Status === 'Document_Loaded') {
        collaboraReady = true;
      }
      break;

    case 'Import_WordMeta_Resp':
      console.log('Import_WordMeta_Resp:', msg.Values);
      break;

    case 'WordMeta_IndexReady':
      console.log('WordMeta_IndexReady:', msg.Values);
      indexReady = true;
      break;

    case 'Navigate_WordTime_Resp':
      // Use this for logging/debugging only.
      break;
  }
});

function postToCollabora(messageId, values) {
  const payload = { MessageId: messageId, Values: values };
  iframe.contentWindow.postMessage(JSON.stringify(payload), collaboraOrigin);
}
```

### 5.2 Importing metadata

```js
async function importWordMeta(words) {
  if (!collaboraReady) return;
  postToCollabora('Import_WordMeta', { words });
}
```

### 5.3 Playback gating

```js
function canPlay() {
  return collaboraReady && indexReady;
}
```

### 5.4 Syncing audio time to Collabora

Throttle time updates (50–100ms) to avoid flooding messages.

```js
let lastSent = 0;
const throttleMs = 80;

audio.addEventListener('timeupdate', () => {
  const now = Date.now();
  if (now - lastSent < throttleMs) return;
  lastSent = now;

  if (!canPlay()) return;
  postToCollabora('Navigate_WordTime', { time: audio.currentTime });
});
```

---

## 6) Troubleshooting checklist

- Do you receive `Import_WordMeta_Resp`?
- Do you receive `WordMeta_IndexReady`?
- Does `Navigate_WordTime_Resp` show `found=true` and `hasBookmark=true`?
- Are `PostMessageOrigin` and iframe `postMessageOrigin` exactly matching the parent origin?
- Is the parent posting to the **Collabora** origin, not itself?

---

## 7) Notes and constraints

- Word order in `words[]` must match document word order.
- If transcript text differs from the document (punctuation, whitespace), some words will not map.
- Highlighting is selection-based, not style-based; if selection is blocked or replaced, the highlight may not appear.
