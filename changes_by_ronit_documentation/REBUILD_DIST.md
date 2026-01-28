# Collabora Dist Folder Recovery Guide

This guide documents the procedure to recreate the `browser/dist` folder from the official Collabora Docker image and restore custom modifications. Use this if `bundle.js` becomes corrupted or if you need to reset the frontend assets.

## Prerequisites
- Docker installed and running
- `docker-compose.yml` configured for the project

## Quick Deploy Command (After Code Changes)

When you make changes to custom source files, run this to apply them:

```bash
# Copy all modified source files to dist and restart container
cp ./browser/src/map/handler/Map.WOPI.js ./browser/dist/src/map/handler/Map.WOPI.js && \
cp ./browser/src/layer/tile/WriterTileLayer.js ./browser/dist/src/layer/tile/WriterTileLayer.js && \
cp ./browser/src/control/Control.WordMeta.js ./browser/dist/src/control/Control.WordMeta.js && \
docker-compose restart collabora
```

**Note:** For `TextInput.js` and `CanvasTileLayer.js`, changes require a full bundle rebuild. See "Custom Files Overview" section below for details.

---

## Step-by-Step Procedure (Full Reset)

### 1. Stop Existing Containers
Ensure no containers are running that might lock the files or mount the volume.

```bash
docker-compose down
```

### 2. Extract Clean Dist Folder
We need to extract the `dist` folder from the Docker **image** directly, not from a running container that has the volume mount active (which would just copy your local, potentially corrupted files).

```bash
# Create a temporary container from the image (do not start it)
docker create --name temp_collabora collabora/code:latest

# Copy the clean dist folder to a temporary location
docker cp temp_collabora:/usr/share/coolwsd/browser/dist ./browser/dist_fresh

# Remove the temporary container
docker rm temp_collabora
```

> **Note:** If you are using a specific version, replace `collabora/code:latest` with your tag (e.g., `collabora/code:25.04.8.1.1`).
> **Warning:** The `25.04.8.1.1` image was found to have a syntax error in `bundle.js`. Use `latest` or a known good version if possible, or manually patch the syntax error if required.

### 3. Replace the Corrupted Dist Folder
Backup your old folder and swap in the fresh one.

```bash
# Backup the existing (corrupted) dist folder
mv ./browser/dist ./browser/dist.backup

# Move the fresh folder into place
mv ./browser/dist_fresh ./browser/dist
```

### 4. Restore Custom Modifications
Copy your custom/modified source files into the new `dist/src` directory.

```bash
# Copy all custom JavaScript files
cp ./browser/src/map/handler/Map.WOPI.js ./browser/dist/src/map/handler/
cp ./browser/src/layer/tile/WriterTileLayer.js ./browser/dist/src/layer/tile/
cp ./browser/src/control/Control.WordMeta.js ./browser/dist/src/control/

# Verify copies
ls -la ./browser/dist/src/map/handler/Map.WOPI.js
ls -la ./browser/dist/src/layer/tile/WriterTileLayer.js
ls -la ./browser/dist/src/control/Control.WordMeta.js
```

### 5. Restart the Container
Ensure your `docker-compose.yml` has the volume mount enabled:

```yaml
volumes:
  - ./browser/dist:/usr/share/coolwsd/browser/dist
```

Run the container:

```bash
docker-compose up -d
```

Or restart if already running:

```bash
docker-compose restart collabora
```

### 6. Verify Fix
Check if the editor loads properly in your browser and look for the custom mount logs:

```
🟢 [CUSTOM MOUNT] Map.WOPI.js loaded - overriding bundled WOPI handler
🟢 [CUSTOM MOUNT] WriterTileLayer.js loaded successfully!
```

---

## Custom Files Overview

### Files Loaded AFTER bundle.js (Can be hot-swapped)

These files are loaded as separate scripts after `bundle.js` in `cool.html`, so changes can be applied by simply copying to dist:

| File | Description |
|------|-------------|
| `browser/src/map/handler/Map.WOPI.js` | PostMessage handling, speaker detection, hotkey interception |
| `browser/src/layer/tile/WriterTileLayer.js` | Writer-specific tile layer customizations |
| `browser/src/control/Control.WordMeta.js` | Word metadata control for timestamps |

**To apply changes:**
```bash
cp ./browser/src/<path-to-file>.js ./browser/dist/src/<path-to-file>.js
docker-compose restart collabora
```

### Files BUNDLED into bundle.js (Require full rebuild)

These files are compiled into `bundle.js` and cannot be simply replaced:

| File | Description |
|------|-------------|
| `browser/src/layer/marker/TextInput.js` | Keyboard input handling |
| `browser/src/layer/tile/CanvasTileLayer.js` | Base canvas tile layer |

**To apply changes:** Requires rebuilding the entire Collabora frontend (complex, not recommended for development).

**Workaround:** For hotkey interception, we added a document-level keyboard interceptor in `Map.WOPI.js` instead of modifying `TextInput.js`.

---

## How cool.html Loads Custom Scripts

The file `browser/dist/cool.html` includes these script tags after `bundle.js`:

```html
<script defer src="src/layer/tile/WriterTileLayer.js"></script>
<script defer src="src/map/handler/Map.WOPI.js"></script>
<script defer src="src/control/Control.WordMeta.js"></script>
```

These scripts override the bundled versions by redefining the Leaflet/Map components.

---

## Troubleshooting

**Issue:** `bundle.js` syntax errors (e.g., `missing ) after argument list`).
**Cause:** 
1. The file might have been corrupted by direct text replacements (e.g., regex scripts).
2. The specific Docker image version might have a broken build.

**Solution:** Always extract from a clean image without volume mounts. If the image itself is broken, upgrade to `latest`.

**Issue:** Custom code changes not taking effect.
**Cause:** Browser caching the old scripts.

**Solution:** Hard refresh (Cmd+Shift+R on Mac, Ctrl+Shift+R on Windows/Linux) after restarting the container.

**Issue:** `[Map.WOPI] Replacing existing WOPI handler on map...` not appearing.
**Cause:** The Map.WOPI.js script isn't loading or cool.html doesn't have the script tag.

**Solution:** Verify `cool.html` includes the script tag for Map.WOPI.js.
