# Updating the Server Docker Image (Without Full Rebuild)

This guide covers how to apply hot-swappable changes to the existing `ronitgandotra/collabora-ronit-version` Docker Hub image without running a full `./build.sh`. You are **updating the same image tag** — no new image name needed.

## When to Use This Guide

Use this when you have made changes to **hot-swappable files** — files loaded as separate `<script>` tags in `cool.html` that are NOT bundled into `bundle.js`. These files can be swapped by copying them into the compiled `instdir` and rebuilding only the final Docker packaging layer.

## Files Changed in This Update

| File | What Changed |
|---|---|
| `browser/dist/src/control/Control.WordMeta.js` | Half-open interval fix for `findWordByTime` (off-by-one highlighting) |
| `browser/dist/src/layer/marker/TextInput.js` | Audio playback editing guard (prevents typing during playback) |
| `browser/dist/src/map/handler/Map.WOPI.js` | Audio shortcut interceptor (arrow keys for word navigation) |
| `browser/dist/cool.html` | Stenope branding, disabled welcome/feedback/update popups |
| `browser/dist/branding.js` | Loading screen: "Stenope Editor" instead of "Collabora Online Development Edition (CODE)" |

## Prerequisites

- SSH access to your build VM (where the original image was built)
- The `docker/from-source/instdir` directory still exists on the VM from the last full build
- Docker Hub login credentials

## Step-by-Step Instructions

### Step 1: Push Changes from Mac to GitHub

On your Mac:

```bash
cd ~/Desktop/Collabora-word-edittor

# Copy source files to dist
cp browser/src/control/Control.WordMeta.js browser/dist/src/control/
cp browser/src/layer/marker/TextInput.js browser/dist/src/layer/marker/
cp browser/src/map/handler/Map.WOPI.js browser/dist/src/map/handler/

# Stage everything (force-add gitignored dist files)
git add browser/src/control/Control.WordMeta.js \
        browser/src/layer/marker/TextInput.js \
        browser/src/map/handler/Map.WOPI.js \
        changes_by_ronit_documentation/

git add -f browser/dist/src/control/Control.WordMeta.js \
           browser/dist/src/layer/marker/TextInput.js \
           browser/dist/src/map/handler/Map.WOPI.js \
           browser/dist/cool.html \
           browser/dist/branding.js

# Commit and push
git commit -m "feat: Stenope branding, audio nav fixes, feedback disabled"
git push origin main
```

### Step 2: SSH into the Build VM and Pull

```bash
ssh your-vm-address
cd ~/Collabora-word-edittor
git pull origin main
```

### Step 3: Find the instdir dist directory

The compiled output from the last full build lives in `docker/from-source/instdir`. Find where `cool.html` is inside it:

```bash
DIST_DIR=$(find ~/Collabora-word-edittor/docker/from-source/instdir -name "cool.html" -type f | head -1 | xargs dirname)
echo "Dist directory inside instdir: $DIST_DIR"
```

Expected output example:
```
Dist directory inside instdir: /home/ronitgandotra/Collabora-word-edittor/docker/from-source/instdir/opt/cool/share/coolwsd/browser/dist
```

If this returns empty, your `instdir` was deleted. You would need a full `./build.sh` rebuild (see `DOCKER_IMAGE_BUILD_GUIDE.md`).

### Step 4: Copy Updated Files into instdir

```bash
# Hot-swappable JS files
cp browser/dist/src/control/Control.WordMeta.js "$DIST_DIR/src/control/"
cp browser/dist/src/layer/marker/TextInput.js "$DIST_DIR/src/layer/marker/"
cp browser/dist/src/map/handler/Map.WOPI.js "$DIST_DIR/src/map/handler/"

# Branding files
cp browser/dist/cool.html "$DIST_DIR/"
cp browser/dist/branding.js "$DIST_DIR/"
```

Verify the copies:

```bash
echo "--- Verifying copies ---"
ls -la "$DIST_DIR/src/control/Control.WordMeta.js"
ls -la "$DIST_DIR/src/layer/marker/TextInput.js"
ls -la "$DIST_DIR/src/map/handler/Map.WOPI.js"
ls -la "$DIST_DIR/cool.html"
ls -la "$DIST_DIR/branding.js"

# Verify branding content
grep "brandProductName" "$DIST_DIR/branding.js"
grep "<title>" "$DIST_DIR/cool.html"
```

Expected:
```
var brandProductName = 'Stenope Editor';
<title>Stenope Editor</title>
```

### Step 5: Rebuild the Final Docker Layer (~2 minutes)

This only repackages the already-compiled `instdir` into a Docker image. No recompilation.

```bash
cd ~/Collabora-word-edittor/docker/from-source

# Copy the startup script (required by the Dockerfile)
cp ../from-packages/scripts/start-collabora-online.sh .

# Build ONLY the final Docker layer
docker build --no-cache -t collabora-ronit-version:latest -f Debian .
```

Verify the image was built:

```bash
docker images | grep collabora-ronit-version
```

### Step 6: Tag and Push to Docker Hub

```bash
# Login if needed
docker login

# Tag with your Docker Hub username
docker tag collabora-ronit-version:latest ronitgandotra/collabora-ronit-version:latest

# Push
docker push ronitgandotra/collabora-ronit-version:latest
```

Wait for the push to complete. Expected success output:
```
latest: digest: sha256:... size: ...
```

### Step 7: Pull and Run on Mac (Local Testing)

```bash
# Pull the updated image
docker pull --platform linux/amd64 ronitgandotra/collabora-ronit-version:latest

# Stop the current container using port 9980
docker stop collabora-code

# Remove any old version of this container
docker rm -f collabora-ronit-version 2>/dev/null || true

# Run the updated image
docker run -d --name collabora-ronit-version \
  --platform linux/amd64 \
  -p 9980:9980 \
  --cap-add MKNOD \
  -e 'aliasgroup1=https://.*' \
  -e 'extra_params=--o:ssl.enable=false --o:ssl.termination=false --o:security.seccomp=false --o:mount_jail_tree=false' \
  ronitgandotra/collabora-ronit-version:latest
```

**Important:** Do NOT bind-mount `browser/dist` when running the baked image. The files are already inside it.

Verify it's running:

```bash
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}"
docker logs --tail=20 collabora-ronit-version
```

### Step 8: Deploy to Cloud Run (Production)

If you deploy to Cloud Run, update the service to use the new image:

```bash
gcloud run deploy collabora-service \
  --image=ronitgandotra/collabora-ronit-version:latest \
  --platform=managed \
  --region=us-central1 \
  --port=9980 \
  --allow-unauthenticated \
  --set-env-vars="aliasgroup1=https://.*,extra_params=--o:ssl.enable=false --o:ssl.termination=false --o:security.seccomp=false --o:mount_jail_tree=false"
```

Or pull and redeploy via the Cloud Run console.

### Step 9: Switch Back to Local Dev Container

If you want to go back to local development with bind-mounted `browser/dist`:

```bash
docker stop collabora-ronit-version
docker start collabora-code
```

## Verification Checklist

After deploying, open the editor and verify:

- [ ] Loading screen shows **"Stenope Editor"** (not Collabora)
- [ ] Browser tab title says **"Stenope Editor"**
- [ ] About dialog shows **"Stenope Editor"** and **"Powered by Stenope.AI"**
- [ ] No welcome popup on first load
- [ ] No feedback popup
- [ ] Click-to-seek highlights the correct word (not off-by-one)
- [ ] Arrow key navigation moves one word at a time (not skipping)
- [ ] Typing is blocked during audio playback mode

## FAQ

### Do I need a new Docker Hub image name?

No. Push to the same `ronitgandotra/collabora-ronit-version:latest` tag. Docker Hub overwrites the tag with the new image.

### What if `instdir` was deleted on the VM?

You need a full `./build.sh` rebuild. See `DOCKER_IMAGE_BUILD_GUIDE.md` Section 5.

### What if I run `./build.sh` again later?

A full build regenerates `cool.html` and `branding.js` from templates, overwriting your branding. After a full build, re-run Steps 4-6 to re-apply the branding.

### Can I use `docker cp` instead of rebuilding?

For temporary testing, yes:
```bash
docker cp browser/dist/branding.js collabora-ronit-version:/usr/share/coolwsd/browser/dist/
docker restart collabora-ronit-version
```
But this doesn't persist in the image — use the full Steps 4-6 for a permanent update.

## Alternative: VM Deleted / No instdir Available

If you deleted the build VM and no longer have `instdir`, you do NOT need a full multi-hour `./build.sh`. Instead, patch the existing Docker Hub image directly using `docker cp` + `docker commit`.

This can be done from **any machine with Docker** (your Mac, a new VM, etc.).

### Step A1: Pull the Existing Image

```bash
docker pull --platform linux/amd64 ronitgandotra/collabora-ronit-version:latest
```

### Step A2: Run a Temporary Container

```bash
docker rm -f collabora-temp 2>/dev/null || true
docker run -d --name collabora-temp \
  --platform linux/amd64 \
  ronitgandotra/collabora-ronit-version:latest
```

### Step A3: Copy Updated Files into the Container

From your Collabora-word-edittor repo on Mac:

```bash
cd ~/Desktop/Collabora-word-edittor

# Find the dist path inside the container
DIST_PATH=$(docker exec collabora-temp find /usr/share/coolwsd -name "cool.html" -type f | head -1 | xargs dirname)
echo "Container dist path: $DIST_PATH"
```

Expected: `/usr/share/coolwsd/browser/dist`

```bash
# Copy all 5 hot-swappable files
docker cp browser/dist/src/control/Control.WordMeta.js collabora-temp:$DIST_PATH/src/control/
docker cp browser/dist/src/layer/marker/TextInput.js collabora-temp:$DIST_PATH/src/layer/marker/
docker cp browser/dist/src/map/handler/Map.WOPI.js collabora-temp:$DIST_PATH/src/map/handler/
docker cp browser/dist/cool.html collabora-temp:$DIST_PATH/
docker cp browser/dist/branding.js collabora-temp:$DIST_PATH/
```

Verify:

```bash
docker exec collabora-temp grep "brandProductName" $DIST_PATH/branding.js
docker exec collabora-temp grep "<title>" $DIST_PATH/cool.html
```

Expected:
```
var brandProductName = 'Stenope Editor';
<title>Stenope Editor</title>
```

### Step A4: Commit the Container as a New Image

```bash
docker commit collabora-temp ronitgandotra/collabora-ronit-version:latest
```

This creates a new image layer with your changes baked in.

### Step A5: Push to Docker Hub

```bash
docker login
docker push ronitgandotra/collabora-ronit-version:latest
```

### Step A6: Clean Up the Temporary Container

```bash
docker rm -f collabora-temp
```

### Step A7: Run the Updated Image

```bash
docker stop collabora-code 2>/dev/null || true
docker rm -f collabora-ronit-version 2>/dev/null || true

docker run -d --name collabora-ronit-version \
  --platform linux/amd64 \
  -p 9980:9980 \
  --cap-add MKNOD \
  -e 'aliasgroup1=https://.*' \
  -e 'extra_params=--o:ssl.enable=false --o:ssl.termination=false --o:security.seccomp=false --o:mount_jail_tree=false' \
  ronitgandotra/collabora-ronit-version:latest
```

This approach works from your Mac directly — no VM needed.
