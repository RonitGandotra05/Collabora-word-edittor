# Speaker Detection and Hotkey System

This document describes the custom speaker detection and hotkey handling system implemented in the Collabora Word Editor.

## Features

1. **Auto Speaker Style Detection** - Automatically detects and caches the paragraph style used for speaker names
2. **Hotkey-Based Speaker Insertion** - Allows quick speaker insertion using keyboard hotkeys (even when cursor is inside the document)
3. **Speaker Paragraph Splitting** - Splits paragraphs and inserts speaker names with proper formatting

---

## Architecture Overview

### Key Files

| File | Purpose |
|------|---------|
| `browser/src/map/handler/Map.WOPI.js` | Main handler for speaker detection, hotkey interception, and PostMessage communication |
| `frontend/src/pages/CollaboraEditorPage.js` | React component that manages hotkey mode state and speaker insertion commands |

### Communication Flow

```
┌─────────────────────────┐         PostMessage          ┌────────────────────────────┐
│  CollaboraEditorPage.js │ ◄──────────────────────────► │  Map.WOPI.js (in iframe)   │
│  (React Frontend)       │                              │  (Collabora Editor)        │
└─────────────────────────┘                              └────────────────────────────┘
         │                                                         │
         │ Hotkey_Mode_Config                                      │ Hotkey_Pressed
         │ Capture_Speaker_Indent                                  │ Speaker_Indent_Resp
         │ Send_UNO_Command                                        │ Hotkey_Mode_Exit
         ▼                                                         ▼
```

---

## Speaker Detection (`Capture_Speaker_Indent`)

### How It Works

1. **Frontend triggers detection** by sending `Capture_Speaker_Indent` PostMessage with `wantAuto: true`
2. **Map.WOPI.js searches for colons** in the document using `app.searchService.search(':')`
3. **For each colon found**, it:
   - Positions cursor at the search result
   - Gets the current paragraph style via `.uno:StyleApply`
   - Checks if the style is NOT "Default Paragraph Style"
4. **When valid style found**, it finalizes and sends `Speaker_Indent_Resp` with the style name
5. **Frontend caches the style** in localStorage for the document

### Console Logs (Expected Flow)

```
[SpeakerIndent] Starting auto speaker detection...
[SpeakerIndent] Starting document search for ":"...
[SpeakerIndent] Search found ":" match, requesting selection text...
[SpeakerIndent] Selecting paragraph and requesting text...
[SpeakerIndent] Sending gettextselection request...
[SpeakerIndent] Poll 1/20, text: (empty)
[SpeakerIndent] Poll 5/20, text: (empty)
...
[SpeakerIndent] Attempt 1/8 {lineText: '', style: 'TCRA Colloquy'}
[SpeakerIndent] ✅ Found valid speaker style! {speakerName: '(unknown)', style: 'TCRA Colloquy'}
[SpeakerIndent] ✅ FINALIZED {style: 'TCRA Colloquy', margin: {...}}
```

### Code Location

```javascript
// browser/src/map/handler/Map.WOPI.js
if (msg.MessageId === 'Capture_Speaker_Indent') {
    // Lines ~380-630
}
```

---

## Hotkey Mode

### How It Works

1. **Frontend enables hotkey mode** by sending `Hotkey_Mode_Config` with `enabled: true` and a list of hotkeys
2. **Map.WOPI.js stores the config** in `this._map._hotkeyMode`
3. **Document-level keyboard interceptor** (added in `addHooks`) captures keydown events in the capture phase
4. **When a registered hotkey is pressed**:
   - Event is intercepted before reaching TextInput
   - `preventDefault()` and `stopImmediatePropagation()` prevent character from being typed
   - `Hotkey_Pressed` PostMessage is sent to frontend
5. **Frontend receives the hotkey** and triggers speaker insertion

### Why Document-Level Interception?

The bundled `TextInput.js` in `bundle.js` handles keyboard input. Since we can't easily modify `bundle.js`, we added a capture-phase event listener at the document level in `Map.WOPI.js` that runs BEFORE keyboard events reach TextInput.

### Console Logs (Expected Flow)

```
[CollaboraEditor] Hotkey mode toggled: ON
[CollaboraEditor] Hotkey config sent {enabled: true, hotkeyCount: 2}
Hotkey_Mode_Config_Resp {enabled: true, hotkeyCount: 2}

# When pressing a hotkey:
[Map.WOPI] Hotkey intercepted: 1
[CollaboraEditor] Hotkey handled {key: '1'}
[CollaboraEditor] Hotkey matched speaker {key: '1', name: 'MR. RONIT'}
[CollaboraEditor] Splitting speaker: MR. RONIT
[CollaboraEditor] Speaker split completed
```

### Code Location

```javascript
// browser/src/map/handler/Map.WOPI.js - addHooks function
// Document-level hotkey interceptor - captures keys before TextInput gets them
this._hotkeyInterceptor = function (ev) {
    var hotkeyMode = that._map && that._map._hotkeyMode;
    if (!hotkeyMode || !hotkeyMode.enabled) return;
    
    var key = (ev.key && ev.key.length === 1) ? ev.key.toLowerCase() : '';
    if (key && hotkeyMode.hotkeys && hotkeyMode.hotkeys[key]) {
        console.log('[Map.WOPI] Hotkey intercepted:', key);
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        that._map.fire('postMessage', { msgId: 'Hotkey_Pressed', args: { key: key } });
        return false;
    }
    // ... Escape handling
};
document.addEventListener('keydown', this._hotkeyInterceptor, true);
```

---

## PostMessage API Reference

### From Frontend to Collabora

| Message | Purpose | Payload |
|---------|---------|---------|
| `Hotkey_Mode_Config` | Enable/disable hotkey mode | `{ enabled: bool, hotkeys: ['1', '2', ...] }` |
| `Capture_Speaker_Indent` | Request speaker style detection | `{ wantAuto: true }` or `{ style: '...', margin: '...' }` |
| `Send_UNO_Command` | Execute LibreOffice UNO command | `{ command: '.uno:...', argument: {...} }` |

### From Collabora to Frontend

| Message | Purpose | Payload |
|---------|---------|---------|
| `Hotkey_Mode_Config_Resp` | Confirm hotkey config | `{ enabled: bool, hotkeyCount: number }` |
| `Hotkey_Pressed` | Notify hotkey press | `{ key: 'a' }` |
| `Hotkey_Mode_Exit` | User pressed Escape | `{}` |
| `Speaker_Indent_Resp` | Speaker detection result | `{ style: '...', margin: {...}, auto: bool }` |

---

## Development Workflow

### Making Changes to Map.WOPI.js

1. Edit the source file:
   ```bash
   code browser/src/map/handler/Map.WOPI.js
   ```

2. Copy to dist and restart:
   ```bash
   cp ./browser/src/map/handler/Map.WOPI.js ./browser/dist/src/map/handler/Map.WOPI.js
   docker-compose restart collabora
   ```

3. Hard refresh the browser (Cmd+Shift+R) to clear cache

4. Verify custom code loaded:
   ```
   🟢 [CUSTOM MOUNT] Map.WOPI.js loaded - overriding bundled WOPI handler
   [Map.WOPI] Replacing existing WOPI handler on map...
   [Map.WOPI] WOPI handler replaced successfully!
   ```

### Quick Command

```bash
cp ./browser/src/map/handler/Map.WOPI.js ./browser/dist/src/map/handler/Map.WOPI.js && docker-compose restart collabora
```

---

## Troubleshooting

### Hotkey types character instead of triggering speaker

**Symptoms:** Pressing hotkey (e.g., '1') types the character in document instead of splitting speaker.

**Cause:** Document-level interceptor not running, or hotkey mode not enabled.

**Debug:**
1. Check console for: `[Map.WOPI] Hotkey intercepted: 1`
2. If missing, verify hotkey mode is enabled: `Hotkey_Mode_Config_Resp {enabled: true}`
3. If enabled but not intercepting, hard refresh to reload Map.WOPI.js

### Speaker style not detected

**Symptoms:** `Speaker_Indent_Resp` returns `style: null`.

**Cause:** Either no colon found, or all colon lines have "Default Paragraph Style".

**Debug:**
1. Check console for: `[SpeakerIndent] Attempt X/8 {style: 'Default Paragraph Style'}`
2. Ensure document has speaker lines with a custom paragraph style (not default)

### Poll logs showing "(empty)" continuously

**Symptoms:** 20 polls all show `(empty)` text.

**Cause:** The `gettextselection` response isn't being received. This is a known limitation.

**Impact:** None - the detection now works based on style alone without requiring text verification.

---

## Files Modified Summary

| File | Changes |
|------|---------|
| `Map.WOPI.js` | Added `Capture_Speaker_Indent` handler, document-level hotkey interceptor, `Hotkey_Mode_Config` handler |
| `cool.html` | Added `<script>` tag to load Map.WOPI.js after bundle.js |
| `WriterTileLayer.js` | Added custom mount log |

---

## Future Improvements

1. **Text retrieval reliability**: The `gettextselection` mechanism is unreliable. Consider alternative approaches if text verification becomes necessary.
2. **Style caching**: Currently cached in localStorage by document ID. Could be enhanced to support user preferences.
3. **Multiple speaker styles**: Currently only detects one style. Could be extended to support documents with multiple speaker style patterns.
