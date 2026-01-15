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

