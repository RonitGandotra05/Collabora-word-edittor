# Collabora WordMeta Playback - Implementation Checklist

This document describes exactly what Collabora must do to support word-level audio highlighting
when the React frontend sends `Import_WordMeta` and `Navigate_WordTime` messages.

## 1. What the frontend sends

Frontend postMessage payloads are JSON strings with:

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

```json
{
  "MessageId": "Navigate_WordTime",
  "Values": { "time": 12.34 }
}
```

Optional debug probe:

```json
{
  "MessageId": "Get_WordMeta",
  "Values": { "index": 0 }
}
```

## 2. Required Collabora responses (must be sent)

Collabora must respond to the parent window with:

```json
{
  "MessageId": "Import_WordMeta_Resp",
  "Values": { "success": true, "wordCount": 1234 }
}
```

```json
{
  "MessageId": "Navigate_WordTime_Resp",
  "Values": { "time": 12.34, "wordIndex": 456 }
}
```

```json
{
  "MessageId": "Get_WordMeta_Resp",
  "Values": { "index": 0, "metadata": { "word": "Hello", "start": 0.0, "end": 0.52 } }
}
```

If these responses do not appear, the WordMeta plugin is not loaded or not registered in the
postMessage router.

## 3. PostMessage origin requirements

Collabora will reject messages if the WOPI CheckFileInfo `PostMessageOrigin` does not match the
React app origin. Ensure:

- `PostMessageOrigin` in CheckFileInfo == `http://localhost:3000` (or your frontend origin)
- Collabora URL includes `postMessageOrigin=http%3A%2F%2Flocalhost%3A3000`

Without this, Collabora will ignore `Import_WordMeta` and `Navigate_WordTime`.

## 4. WordMeta plugin responsibilities (Collabora side)

### 4.1 Register the message handlers

Your postMessage router must recognize and route these commands:

- `Import_WordMeta` -> calls `wordMeta.import(words)`
- `Navigate_WordTime` -> calls `wordMeta.navigateToTime(time)`
- `Get_WordMeta` -> returns word metadata for a specific index

### 4.2 Store words and build a search index

Use a structure like:

```
wordMeta.words = [{ word, start, end, confidence }, ...]
wordMeta.wordCount = words.length
```

Build a time index so `Navigate_WordTime` can do binary search:

```
findWordAtTime(time) -> index
```

### 4.3 Map word index to document range

Highlighting requires a mapping from word index to a real document range.
You have two viable approaches:

Approach A (preferred if metadata is embedded in DOCX):
- Your DOCX export already adds metadata per word.
- On `import`, scan document nodes and build a mapping:
  - `wordIndex -> [startPosition, endPosition]` or `wordIndex -> rangeRef`.
- Use this mapping to select and highlight the word.

Approach B (fallback if no embedded metadata):
- Parse the document text in order.
- Tokenize the document into words and match sequentially against `words[]`.
- Build a mapping `wordIndex -> character range` by counting characters.
- This requires exact word order match and consistent tokenization.

### 4.4 Apply highlight in Collabora

Once you have a range:
- Move cursor to range.
- Apply temporary highlight (background color) or selection.

Examples (pseudo):

```
doc.selectRange(startPos, endPos);
doc.applyCharStyle({ background: "#FFE082" });
```

or UNO calls if you use them internally:

```
.uno:SelectText
.uno:BackColor
```

The exact API depends on your Collabora internals. The key is:
1) resolve word index -> range
2) select range
3) apply highlight

### 4.5 Return responses

Always send `Import_WordMeta_Resp` and `Navigate_WordTime_Resp` back to the parent.
The React app uses these to confirm the plugin is active.

## 5. Debug checks inside Collabora

Add logs or console checks:

```
app.map.wordMeta.isLoaded()
app.map.wordMeta.getWordCount()
app.map.wordMeta.getWordMeta(0)
```

Confirm:
- `isLoaded()` true after import
- word count > 0
- `Navigate_WordTime` returns a valid index

## 6. Data alignment requirements

Highlighting only works if the `words[]` array matches the document text exactly.
Common failure causes:

- Extra whitespace or punctuation differences between transcript and DOCX.
- WordMeta indices off by one due to headers or speaker labels.
- DOCX contains formatting inserts not present in the transcript data.

If the match fails:
- Either embed word metadata into DOCX and map by metadata (Approach A),
- Or make the export normalize punctuation and spacing to match the word list exactly.

## 7. Minimal checklist

1) Collabora build includes the WordMeta plugin and postMessage handlers.
2) `Import_WordMeta_Resp` is sent back to parent.
3) `Navigate_WordTime_Resp` is sent back to parent.
4) Word index -> document range mapping exists.
5) Highlighting is visible in Collabora when a word is selected.
6) `PostMessageOrigin` matches the React app origin.

If any of these are missing, highlights will not show.

---

## 8. Implemented changes (this repo)

### 8.1 Collabora-side code changes

- **WordMeta control added**  
  `browser/src/control/Control.WordMeta.js` now stores word metadata, creates bookmarks, and highlights words.
- **PostMessage handlers added**  
  `browser/src/map/handler/Map.WOPI.js` handles `Import_WordMeta`, `Get_WordMeta`, and `Navigate_WordTime`.
- **Plugin initialization**  
  `browser/src/app/ServerConnectionService.ts` initializes the WordMeta control on document load.
- **Build inclusion**  
  `browser/Makefile.am` includes `Control.WordMeta.js` in the browser bundle list.

### 8.2 Bookmark indexing behavior

When `Import_WordMeta` arrives:
- Metadata is stored in memory.
- If the DOCX already contains `WMETA_<index>` bookmarks, Collabora reuses them and only indexes missing words.
- Bookmark indexing runs **in the background** (batched).
- Each missing word is located via `.uno:ExecuteSearch`, then a bookmark is inserted with `.uno:InsertBookmark`.
- Bookmark names are `WMETA_<index>` (index is 0-based).
- Highlighting prefers bookmark jump (`.uno:JumpToMark`) when available, otherwise it falls back to search.
- Navigation is debounced to reduce UI thrashing.

Key parameters (tunable in `Control.WordMeta.js`):
- `batchSize = 50`
- `batchDelayMs = 10`
- `searchTimeoutMs = 1500`
- `highlightDebounceMs = 80`

### 8.3 Known limitations

- Bookmark creation is **sequential search-based**. If the transcript differs from the document (punctuation/whitespace), some words may not map.
- Bookmark jump behavior depends on Collabora’s handling of `.uno:JumpToMark`. If it only moves the cursor, highlight styling may still need a core-side command for selection + highlight.

---

## 9. Frontend ↔ Collabora communication

### 9.1 Required setup

1) In WOPI `CheckFileInfo`, set:
```
PostMessageOrigin = http://localhost:3000
```

2) In the Collabora iframe URL, pass:
```
postMessageOrigin=http%3A%2F%2Flocalhost%3A3000
```

If these do not match your frontend origin, Collabora will ignore messages.

### 9.2 Commands (Frontend → Collabora)

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

### 9.3 Responses (Collabora → Frontend)

```json
{
  "MessageId": "Import_WordMeta_Resp",
  "Values": { "success": true, "wordCount": 1234 }
}
```

```json
{
  "MessageId": "Navigate_WordTime_Resp",
  "Values": { "time": 12.34, "wordIndex": 456 }
}
```

```json
{
  "MessageId": "Get_WordMeta_Resp",
  "Values": { "index": 0, "metadata": { "word": "Hello", "start": 0.0, "end": 0.52 } }
}
```

### 9.4 Frontend example (postMessage)

```js
const msg = {
  MessageId: 'Import_WordMeta',
  Values: { words }
};
iframe.contentWindow.postMessage(JSON.stringify(msg), 'http://localhost:9980');
```

### 9.5 Runtime debugging

In the Collabora iframe console:
```
app.map.wordMeta.isLoaded()
app.map.wordMeta.getWordCount()
```

In the parent window console:
```
window.addEventListener('message', (e) => console.log('MSG:', e.data));
```
