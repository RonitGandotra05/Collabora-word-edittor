# Download Job & Upload Job Features

## Overview

The Download Job and Upload Job features enable exporting and importing complete transcription sessions as portable `.tisa` packages. This allows users to:

1. **Download Job**: Export the current editor state (document, timestamps, speakers, audio) as a single `.tisa` file
2. **Upload Job**: Import a previously exported `.tisa` file to resume editing in a new session

---

## Feature Summary

| Feature | Description |
|---------|-------------|
| **Download Job** | Creates a `.tisa` ZIP archive containing all session data |
| **Upload Job** | Extracts a `.tisa` file and creates a new editor session |
| **File Format** | `.tisa` = ZIP archive with manifest, document, timestamps, speakers, audio |
| **UI Location** | Buttons in the EditorSidebar component |

---

## Architecture

### Component Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          REACT FRONTEND                                      │
│  CollaboraEditorPage.js                                                      │
│  ┌─────────────────────┐              ┌─────────────────────┐               │
│  │ handleDownloadJob() │              │ handleUploadJob()   │               │
│  │ - Saves document    │              │ - Extracts ZIP      │               │
│  │ - Fetches DOCX/audio│              │ - Sends to backend  │               │
│  │ - Creates ZIP       │              │ - Opens new tab     │               │
│  │ - Triggers download │              │                     │               │
│  └─────────────────────┘              └─────────────────────┘               │
│           │                                    │                             │
│           ▼                                    ▼                             │
│  ┌─────────────────────┐              ┌─────────────────────┐               │
│  │    EditorSidebar    │              │    EditorSidebar    │               │
│  │    "Download Job"   │              │    "Upload Job"     │               │
│  │    button           │              │    button + input   │               │
│  └─────────────────────┘              └─────────────────────┘               │
└─────────────────────────────────────────────────────────────────────────────┘
                                                 │
                                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          FLASK BACKEND                                       │
│  api.py                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  POST /api/upload-job                                                │    │
│  │  - Receives multipart form-data                                      │    │
│  │  - Saves DOCX to WOPI storage                                       │    │
│  │  - Uploads audio to GCS                                             │    │
│  │  - Creates session metadata in MongoDB                              │    │
│  │  - Returns editor URL                                               │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## .tisa File Format

The `.tisa` file is a ZIP archive with the following structure:

```
job_export.tisa
├── manifest.json          # Metadata about the export
├── document.docx          # The edited DOCX document
├── timestamps.json        # Word-level timestamp data
├── speakers.json          # Speaker configuration
└── audio.{mp3|wav|webm|m4a}  # Audio file (optional)
```

### manifest.json Structure

```json
{
  "version": "1.0.0",
  "format": "tisa-job",
  "created": "2026-02-08T10:30:00.000Z",
  "sessionId": "abc123-456-789",
  "title": "My Transcript",
  "files": {
    "document": "document.docx",
    "timestamps": "timestamps.json",
    "speakers": "speakers.json",
    "audio": "audio.mp3"
  }
}
```

### timestamps.json Structure

```json
[
  {
    "word": "Hello",
    "start": 0.0,
    "end": 0.5,
    "index": 0,
    "paragraphIndex": 1,
    "bookmarkName": "WMETA_0"
  },
  {
    "word": "world",
    "start": 0.5,
    "end": 1.0,
    "index": 1,
    "paragraphIndex": 1,
    "bookmarkName": "WMETA_1"
  }
]
```

### speakers.json Structure

```json
{
  "1": { "name": "Speaker A", "hotkey": "a" },
  "2": { "name": "Speaker B", "hotkey": "b" }
}
```

---

## Files Modified

### 1. `CollaboraEditorPage.js` (Frontend)

**Location**: `frontend/src/pages/CollaboraEditorPage.js`

#### handleDownloadJob() - Lines 718-833

This function handles exporting the current session:

```javascript
const handleDownloadJob = useCallback(async () => {
    // 1. Trigger a save to persist latest edits
    sendPostMessage('Action_Save', { DontTerminateEdit: true, DontSaveIfUnmodified: false });
    await new Promise(resolve => setTimeout(resolve, 1500));

    // 2. Prepare data
    const wordTimestamps = rawWordTimestamps;
    const speakers = editorSpeakers;
    const audioUrl = effectiveAudioUrl;

    // 3. Fetch saved DOCX from WOPI storage
    const docxUrl = `${API_URL}/wopi/files/${fileId}/contents?access_token=...`;
    const docxBlob = await fetch(docxUrl).then(r => r.blob());

    // 4. Fetch audio if available
    const audioBlob = await fetch(audioUrl).then(r => r.blob());

    // 5. Create ZIP using JSZip
    const zip = new JSZip();
    zip.file('document.docx', docxBlob);
    zip.file('timestamps.json', JSON.stringify(wordTimestamps, null, 2));
    zip.file('speakers.json', JSON.stringify(speakers, null, 2));
    zip.file(`audio.${audioExt}`, audioBlob);
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    // 6. Generate and download
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = window.URL.createObjectURL(zipBlob);
    a.download = `${safeName}.tisa`;
    a.click();
}, [...dependencies]);
```

#### handleUploadJob() - Lines 835-930

This function handles importing a `.tisa` file:

```javascript
const handleUploadJob = useCallback(async (file) => {
    // 1. Extract ZIP using JSZip
    const zip = await JSZip.loadAsync(file);

    // 2. Read manifest
    const manifest = JSON.parse(await zip.file('manifest.json').async('text'));

    // 3. Read timestamps and speakers
    const wordTimestamps = JSON.parse(await zip.file('timestamps.json').async('text'));
    const speakers = JSON.parse(await zip.file('speakers.json').async('text'));

    // 4. Get document and audio blobs
    const docxBlob = await zip.file('document.docx').async('blob');
    const audioBlob = await zip.file('audio.mp3')?.async('blob'); // tries multiple extensions

    // 5. Create FormData and POST to backend
    const formData = new FormData();
    formData.append('document', docxBlob, 'document.docx');
    formData.append('wordTimestamps', JSON.stringify(wordTimestamps));
    formData.append('speakers', JSON.stringify(speakers));
    formData.append('title', manifest?.title || 'Uploaded Job');
    formData.append('origin', window.location.origin);
    formData.append('audio', audioBlob, audioFilename);

    const response = await fetch(`${API_URL}/api/upload-job`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
    });

    // 6. Open new editor in new tab
    const result = await response.json();
    window.open(result.editorUrl, '_blank');
}, []);
```

---

### 2. `EditorSidebar.js` (UI Component)

**Location**: `frontend/src/components/collabora/EditorSidebar.js`

#### Props Added

```javascript
function EditorSidebar({
    // ...existing props
    onDownloadJob,   // Handler for download button
    onUploadJob      // Handler for upload file
}) {
```

#### Download Button - Lines 96-110

```jsx
{onDownloadJob && (
    <button className="hotkey-toggle" onClick={onDownloadJob}>
        <svg><!-- download icon --></svg>
        <span className="toggle-text">Download Job</span>
    </button>
)}
```

#### Upload Button with Hidden Input - Lines 112-132

```jsx
{onUploadJob && (
    <>
        <input
            type="file"
            ref={uploadInputRef}
            onChange={handleFileChange}
            accept=".tisa,.zip"
            style={{ display: 'none' }}
        />
        <button className="hotkey-toggle" onClick={handleUploadClick}>
            <svg><!-- upload icon --></svg>
            <span className="toggle-text">Upload Job</span>
        </button>
    </>
)}
```

---

### 3. `api.py` (Backend)

**Location**: `backend/app/routes/api.py`

#### POST /api/upload-job - Lines 6849-6966

```python
@api.route('/upload-job', methods=['POST'])
@token_required
def upload_job():
    """
    Upload a .tisa job package to create a new editor session.
    Accepts multipart form-data with:
    - document: DOCX file
    - audio: Audio file (optional)
    - wordTimestamps: JSON string
    - speakers: JSON string
    - title: String
    - origin: String (frontend origin for WOPI URLs)
    """
    # 1. Get uploaded files
    doc_file = request.files.get('document')
    audio_file = request.files.get('audio')

    # 2. Get form data
    title = request.form.get('title', 'Uploaded Job')
    origin = request.form.get('origin', 'http://localhost:3000')
    word_timestamps = json.loads(request.form.get('wordTimestamps', '[]'))
    speakers = json.loads(request.form.get('speakers', '{}'))

    # 3. Generate unique file ID and save to WOPI storage
    file_id = str(uuid.uuid4()) + '.docx'
    wopi_path = get_file_path(file_id)
    doc_file.save(wopi_path)

    # 4. Upload audio to GCS
    if audio_file:
        audio_url = gcs_service.upload_audio(audio_blob, audio_filename)

    # 5. Store file metadata for WOPI config endpoint
    store_file_metadata(
        file_id=file_id,
        session_id=file_id,
        word_timestamps=word_timestamps,
        audio_url=audio_url,
        post_message_origin=origin
    )

    # 6. Store metadata in MongoDB
    db.uploaded_jobs.insert_one({
        'fileId': file_id,
        'title': title,
        'speakers': speakers,
        'wordTimestamps': word_timestamps,
        'audioUrl': audio_url,
        'createdAt': datetime.now(timezone.utc),
        'userId': request.user_id
    })

    # 7. Return editor URL
    editor_url = f"{origin}/editor/{file_id}?title={title}&speakers=..."
    return jsonify({
        'status': 'success',
        'fileId': file_id,
        'editorUrl': editor_url,
        'audioUrl': audio_url
    })
```

---

## UI Integration

The buttons are passed to `EditorSidebar` from `CollaboraEditorPage`:

```jsx
<EditorSidebar
    // ...other props
    onDownloadJob={handleDownloadJob}
    onUploadJob={handleUploadJob}
/>
```

### Button Styling

Both buttons use the existing `.hotkey-toggle` CSS class for consistent styling:

```css
.hotkey-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s;
}

.hotkey-toggle:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.2);
}
```

---

## Message Flow

### Download Job Flow

```
User: Clicks "Download Job" button
  │
  ▼
EditorSidebar: Calls onDownloadJob prop
  │
  ▼
CollaboraEditorPage: handleDownloadJob() executes
  │
  ├── PostMessage: 'Action_Save' to Collabora iframe
  │
  ├── Fetch: GET /wopi/files/{fileId}/contents (get saved DOCX)
  │
  ├── Fetch: GET {audioUrl} (get audio file)
  │
  ├── JSZip: Create ZIP archive
  │
  └── Browser: Download .tisa file
```

### Upload Job Flow

```
User: Clicks "Upload Job" button → File dialog opens
  │
  ▼
User: Selects .tisa file
  │
  ▼
EditorSidebar: handleFileChange() → onUploadJob(file)
  │
  ▼
CollaboraEditorPage: handleUploadJob(file) executes
  │
  ├── JSZip: Extract ZIP contents
  │
  ├── Parse: manifest.json, timestamps.json, speakers.json
  │
  ├── Fetch: POST /api/upload-job (multipart form-data)
  │     │
  │     ▼
  │   Backend: Creates new session
  │     ├── Saves DOCX to WOPI storage
  │     ├── Uploads audio to GCS
  │     ├── Stores metadata in MongoDB
  │     └── Returns editor URL
  │
  └── Browser: window.open(editorUrl, '_blank')
```

---

## Console Logs (For Debugging)

### Download Job

```
[DownloadJob] Processing export...
[DownloadJob] DOCX fetched successfully
[DownloadJob] Audio fetched: audio.mp3
[DownloadJob] ZIP exported successfully: My_Transcript.tisa
```

### Upload Job

```
[UploadJob] Processing file: My_Transcript.tisa
[UploadJob] Manifest: { version: '1.0.0', format: 'tisa-job', ... }
[UploadJob] Upload successful: { status: 'success', fileId: '...', editorUrl: '...' }
```

### Error Cases

```
[DownloadJob] Failed to fetch DOCX: 404
[DownloadJob] Audio fetch error: NetworkError
[DownloadJob] Export failed: Error message

[UploadJob] No document.docx found in the uploaded file
[UploadJob] Upload failed: Error message
```

---

## Dependencies

| Package | Purpose | Import |
|---------|---------|--------|
| **JSZip** | Create/extract ZIP archives | `import('jszip')` (dynamic) |

The JSZip library is imported dynamically when needed:

```javascript
const JSZip = (await import('jszip')).default;
```

---

## Security Considerations

1. **Authentication**: The `/api/upload-job` endpoint requires JWT authentication via `@token_required` decorator
2. **WOPI Access Token**: DOCX file fetching uses WOPI access tokens for authorization
3. **File Validation**: The upload job validates that `document.docx` exists in the ZIP
4. **Sanitization**: Filename sanitization removes dangerous characters before download

---

## Known Limitations

1. **Large Files**: Very large audio files may cause memory issues during ZIP creation
2. **Browser Compatibility**: Uses modern APIs like `Blob`, `URL.createObjectURL`, dynamic imports
3. **Audio Formats**: Only supports mp3, wav, webm, m4a audio extensions
4. **Single File**: Cannot batch export multiple sessions

---

## Future Enhancements

1. **Progress Indicator**: Show progress bar during large file download/upload
2. **Compression Options**: Allow user to choose compression level
3. **Selective Export**: Option to exclude audio for smaller file size
4. **Version Migration**: Handle older `.tisa` format versions
5. **Drag & Drop**: Support drag-and-drop for upload

---

## Related Files

- [PARAGRAPH_MARKERS.md](./PARAGRAPH_MARKERS.md) - Paragraph marker feature
- [wordmeta-changes.md](./wordmeta-changes.md) - WordMeta system overview
- [README_SPEAKER_DETECTION.md](./README_SPEAKER_DETECTION.md) - Speaker detection documentation
