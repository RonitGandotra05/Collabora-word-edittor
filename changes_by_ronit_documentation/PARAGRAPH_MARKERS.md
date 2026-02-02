# Paragraph Timestamp Markers

## Overview

The Paragraph Timestamp Markers feature adds visual markers to the left side of the Collabora document that indicate the start of each paragraph with associated audio timestamps. When clicked, these markers seek the audio playback to the corresponding paragraph's first word.

## Feature Summary

- **Visual Indicators**: Purple circular play button markers (▶) displayed on the left side of the document
- **Paragraph Alignment**: Markers are positioned at the exact Y-coordinate of each paragraph's first timestamped word
- **Audio Seeking**: Clicking a marker sends a `Seek_To_Paragraph` message to seek audio playback to that paragraph
- **Scroll Sync**: Markers scroll with the document content using fixed positioning with scroll tracking
- **Dynamic Visibility**: Markers only appear when audio playback mode is enabled

---

## Architecture

### Component Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            REACT FRONTEND                                    │
│  CollaboraEditorPage.js                                                      │
│  ┌─────────────────┐                           ┌─────────────────────────┐  │
│  │ Audio_Playback_ │ ──── PostMessage ────────▶│ Seek_To_Paragraph       │  │
│  │ Mode: true      │                           │ Handler                 │  │
│  └─────────────────┘                           │ - Seeks audio player    │  │
│                                                │ - Highlights word       │  │
│                                                └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                              │                              ▲
                              ▼                              │
┌─────────────────────────────────────────────────────────────────────────────┐
│                       COLLABORA IFRAME (Leaflet)                             │
│                                                                              │
│  ┌──────────────────┐      ┌──────────────────┐      ┌─────────────────┐    │
│  │   Map.WOPI.js    │      │Control.WordMeta.js│     │ Paragraph       │    │
│  │ Audio_Playback_  │─────▶│ setAudioPlayback │─────▶│ Markers         │    │
│  │ Mode Handler     │      │ Mode()            │      │ (DOM Elements)  │    │
│  └──────────────────┘      └──────────────────┘      └─────────────────┘    │
│                                     │                                        │
│                                     ▼                                        │
│                            ┌─────────────────────────┐                       │
│                            │ _createParagraphMarkers │                       │
│                            │ _positionParagraphMarkers│                      │
│                            │ _updateMarkerPositions  │                       │
│                            └─────────────────────────┘                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Files Modified

### 1. `Control.WordMeta.js` (Primary Implementation)

**Location**: `browser/src/control/Control.WordMeta.js`

#### Key Methods Added

| Method | Purpose |
|--------|---------|
| `setAudioPlaybackMode(enabled)` | Toggles marker visibility based on audio playback state |
| `_createParagraphMarkers()` | Creates marker DOM elements for each paragraph |
| `_positionParagraphMarkers()` | Initiates sequential marker positioning |
| `_positionMarkersSequentially(index)` | Positions markers using bookmark locations |
| `_getOrCreateMarkerContainer()` | Creates the fixed-position container |
| `_setupScrollListener()` | Sets up MutationObserver for scroll tracking |
| `_updateMarkerPositions()` | Updates screen positions on scroll |
| `_createMarkerElement()` | Creates individual marker DOM element |
| `_onParagraphMarkerClick()` | Handles click to send seek message |
| `_destroyParagraphMarkers()` | Cleans up markers when disabled |

#### Data Structures

```javascript
// Paragraph index mapping (paragraph index → first timestamped word index)
this._paragraphFirstWords = {
    5: 0,      // Paragraph 5's first timestamped word is at index 0
    7: 42,     // Paragraph 7's first timestamped word is at index 42
    9: 86,     // etc.
};

// Array of marker DOM elements
this._paragraphMarkers = [marker1, marker2, marker3, ...];

// Base Y positions (in document coordinates, pixels)
this._markerBasePositions = [280.13, 449.47, 652.67, 923.60, 1339.07];
```

---

### 2. `Map.WOPI.js` (PostMessage Handler)

**Location**: `browser/src/map/handler/Map.WOPI.js`

#### Handler Added

```javascript
case 'Audio_Playback_Mode':
    console.log('[Map.WOPI] Audio_Playback_Mode:', msg.Values.enabled);
    if (app.map.wordMeta) {
        app.map.wordMeta.setAudioPlaybackMode(msg.Values.enabled);
    }
    this._postMessage('Audio_Playback_Mode_Resp', {
        enabled: msg.Values.enabled,
        success: true
    });
    break;
```

This handler:
1. Receives the `Audio_Playback_Mode` PostMessage from the React frontend
2. Calls `setAudioPlaybackMode()` on the WordMeta control
3. Sends a response back to confirm the mode change

---

### 3. `CollaboraEditorPage.js` (React Frontend)

**Location**: `frontend/src/pages/CollaboraEditorPage.js`

#### Changes Made

1. **Send Audio_Playback_Mode on state change**:
```javascript
useEffect(() => {
    if (!collaboraReady) return;
    sendPostMessage('Audio_Playback_Mode', { enabled: audioPlaybackMode });
    console.log('[CollaboraEditor] Sent Audio_Playback_Mode:', audioPlaybackMode);
}, [audioPlaybackMode, collaboraReady, sendPostMessage]);
```

2. **Handle Seek_To_Paragraph message**:
```javascript
case 'Seek_To_Paragraph':
    console.log('[CollaboraEditor] Seek_To_Paragraph:', msg.paragraphIndex, 'wordIndex:', msg.wordIndex);
    const audioElement = document.getElementById('collabora-audio-element');
    if (audioElement && msg.timestamp !== undefined) {
        audioElement.currentTime = msg.timestamp;
        if (audioElement.paused) {
            audioElement.play();
        }
    }
    break;
```

---

## Positioning System

### Overview

The paragraph markers use a **fixed positioning** approach with scroll tracking:

1. **Container**: A `div` with `position: fixed` is appended to `document.body`
2. **Markers**: Each marker has `position: fixed` for absolute screen positioning
3. **Scroll Sync**: A `MutationObserver` watches the `.leaflet-map-pane` transform changes

### Position Calculation Flow

```
1. For each paragraph with timestamps:
   │
   ├── Find first timestamped word index
   │
   ├── Get bookmark name (e.g., "WMETA_42")
   │
   ├── Jump to bookmark using .uno:JumpToMark
   │
   ├── Read cursor position from app.file.textCursor.rectangle
   │
   ├── Convert twips to pixels:
   │   cursorY = rect.y1 * (96 / 1440)  // twips to pixels
   │
   └── Store in _markerBasePositions[index]

2. After all positions collected:
   │
   ├── Call _updateMarkerPositions()
   │
   └── Scroll back to document start

3. On scroll (MutationObserver triggers):
   │
   ├── Extract translateY from map-pane transform
   │
   ├── Get document container bounding rect
   │
   └── For each marker:
       screenY = baseY + translateY + containerRect.top
       screenX = containerRect.left + 10
```

### Coordinate Spaces

| Coordinate Type | Description | Example |
|-----------------|-------------|---------|
| Twips | LibreOffice internal units | y1: 4202 |
| Document Pixels | Converted from twips | y: 280.13px |
| Screen Pixels | After scroll/transform offset | top: 180.13px |

---

## Marker Styling

```css
/* Marker container - fixed at body level */
#wordmeta-paragraph-markers {
    position: fixed;
    left: 0;
    top: 0;
    width: 50px;
    height: 100vh;
    pointer-events: none;
    z-index: 99999;
    overflow: visible;
}

/* Individual markers */
.wordmeta-paragraph-marker {
    position: fixed;
    width: 28px;
    height: 28px;
    background: rgba(124, 77, 255, 0.9);  /* Purple */
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 4px rgba(0,0,0,0.3);
    font-size: 14px;
    color: white;
    font-weight: bold;
    pointer-events: auto;
    transition: top 0.1s ease-out, background 0.2s;
}

/* Hover state */
.wordmeta-paragraph-marker:hover {
    transform: scale(1.2);
    background: rgba(124, 77, 255, 1);
}
```

---

## Message Flow

### Enabling Audio Playback Mode

```
React: setAudioPlaybackMode(true)
  │
  ▼
React: sendPostMessage('Audio_Playback_Mode', {enabled: true})
  │
  ▼ (PostMessage)
Collabora: Map.WOPI.js receives 'Audio_Playback_Mode'
  │
  ▼
Collabora: wordMeta.setAudioPlaybackMode(true)
  │
  ▼
Collabora: _createParagraphMarkers()
  │
  ▼
Collabora: _positionParagraphMarkers()
  │
  ▼
Collabora: PostMessage 'Audio_Playback_Mode_Resp' back to React
```

### Clicking a Marker

```
User: Clicks marker
  │
  ▼
Collabora: _onParagraphMarkerClick(paragraphIndex, wordIndex, word)
  │
  ▼
Collabora: PostMessage to parent window:
  {
    MessageId: 'Seek_To_Paragraph',
    paragraphIndex: 5,
    wordIndex: 42,
    timestamp: 13.12,
    word: 'company'
  }
  │
  ▼ (PostMessage)
React: CollaboraEditorPage receives 'Seek_To_Paragraph'
  │
  ▼
React: audioElement.currentTime = 13.12
  │
  ▼
Audio: Seeks to 13.12 seconds and plays
```

---

## Paragraph Detection

Paragraphs are detected using the `paragraphIndex` property from the backend DOCX parsing:

```javascript
// During _buildParagraphIndex()
this._wordMetadata.forEach(function (word) {
    var paraIdx = word.paragraphIndex;
    if (!paragraphWords[paraIdx]) {
        paragraphWords[paraIdx] = [];
    }
    paragraphWords[paraIdx].push(word);
});

// Find first timestamped word per paragraph
for (var i = 0; i < paraIndices.length; i++) {
    var paraIdx = paraIndices[i];
    var words = paragraphWords[paraIdx];
    
    for (var j = 0; j < words.length; j++) {
        if (this._hasValidTimestamp(words[j])) {
            this._paragraphFirstWords[paraIdx] = words[j].index;
            break;
        }
    }
}
```

### Valid Timestamp Check

```javascript
_hasValidTimestamp: function (word) {
    return word && 
           typeof word.start === 'number' && 
           typeof word.end === 'number' &&
           word.start >= 0 &&
           word.end > word.start;
}
```

---

## Console Logs (For Debugging)

### During Initialization
```
========== PARAGRAPH INDEX BUILD START ==========
WordMeta: Using paragraphIndex from backend (DOCX structure)
✅ PARA 5 [HAS TIMESTAMP] | Words: 42 | First TS word: "sales" at index 0 | Timestamp: 0.00s - 0.48s
✅ PARA 7 [HAS TIMESTAMP] | Words: 43 | First TS word: "company" at index 42
...
---------- PARAGRAPH INDEX SUMMARY ----------
Total paragraphs detected: 5
Paragraphs WITH timestamps: 5
========== PARAGRAPH INDEX BUILD END ==========
```

### During Marker Positioning
```
[WordMeta] setAudioPlaybackMode: true
[WordMeta] Creating paragraph markers...
[WordMeta] Created marker container at body level
[WordMeta] Scroll listener set up
[WordMeta] Creating markers for 5 paragraphs
[WordMeta] Created 5 paragraph markers
[WordMeta] Positioning 5 markers
[WordMeta] Jumping to bookmark: WMETA_0 for marker 0
[WordMeta] Marker 0 cursor rect: SimpleRectangle {_x1: 3164, _y1: 4202, ...} pixelY: 280.13
[WordMeta] Marker 0 base position stored: y=280.13
...
[WordMeta] All 5 markers positioned
```

---

## Known Limitations

1. **Positioning During Creation**: The JumpToMark command scrolls the document during positioning. After all markers are positioned, the document scrolls back to the top using `.uno:GoToStartOfDoc`.

2. **Twips to Pixels Conversion**: The conversion uses standard 96 DPI (96/1440 twips per pixel). This may need adjustment for high-DPI displays.

3. **Bookmark Dependency**: Markers require valid bookmarks (WMETA_N) to exist in the document. If a word has no bookmark, fallback positioning is used.

4. **Fixed Left Position**: Markers are always positioned at `left: containerRect.left + 10px`, which may overlap with UI elements in some layouts.

---

## Future Enhancements

1. **Timestamp Display**: Show the actual timestamp (e.g., "00:13:12") alongside or on hover
2. **Active Marker Highlighting**: Highlight the marker corresponding to the currently playing audio position
3. **Zoom Handling**: Adjust marker positions when document zoom changes
4. **Configurable Styling**: Allow customization of marker appearance via CSS variables
5. **Multi-page Documents**: Ensure markers work correctly with page breaks and multi-page layouts

---

## Related Files

- [wordmeta-changes.md](./wordmeta-changes.md) - WordMeta system overview
- [README_SPEAKER_DETECTION.md](./README_SPEAKER_DETECTION.md) - Speaker detection documentation
- [REBUILD_DIST.md](./REBUILD_DIST.md) - How to rebuild and deploy changes
