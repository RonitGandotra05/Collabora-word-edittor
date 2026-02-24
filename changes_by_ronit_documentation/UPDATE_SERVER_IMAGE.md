# Updating the Server Docker Image (Without Full Rebuild)

This guide covers how to apply hot-swappable changes to the existing `ronitgandotra/collabora-ronit-version` Docker Hub image without running a full `./build.sh`. You update the **same image tag** — no new image needed.

**GitHub Repo:** `https://github.com/TisaLegalApps/Collabora-word-edittor.git`
**Docker Hub Image:** `ronitgandotra/collabora-ronit-version:latest`
**Cloud Run Service:** `collabora-ronit-version` (region: `us-central1`)
**Cloud Run URL:** `https://collabora-ronit-version-140170437531.us-central1.run.app`

## Hot-Swappable Files

These files are loaded as separate `<script>` tags in `cool.html` (NOT bundled into `bundle.js`), so they can be replaced without recompiling:

| File | Purpose |
|---|---|
| `browser/dist/src/control/Control.WordMeta.js` | Word timestamp navigation, highlighting, `findWordByTime` |
| `browser/dist/src/layer/marker/TextInput.js` | Text input handler, audio playback editing guard |
| `browser/dist/src/map/handler/Map.WOPI.js` | WOPI message handler, audio shortcut interceptor |
| `browser/dist/cool.html` | Page template, Stenope branding, popup disable flags |
| `browser/dist/branding.js` | Loading screen product name and URLs |

---

## Method: docker cp + docker commit (Recommended)

This is the fastest approach. Works from your **Mac directly** — no build VM needed.

### Step 1: Push Code Changes to GitHub

```bash
cd ~/Desktop/Collabora-word-edittor

# Copy source files to dist (so dist mirrors src)
cp browser/src/control/Control.WordMeta.js browser/dist/src/control/
cp browser/src/layer/marker/TextInput.js browser/dist/src/layer/marker/
cp browser/src/map/handler/Map.WOPI.js browser/dist/src/map/handler/

# Stage tracked source files + documentation
git add browser/src/control/Control.WordMeta.js \
        browser/src/layer/marker/TextInput.js \
        browser/src/map/handler/Map.WOPI.js \
        changes_by_ronit_documentation/

# Force-add gitignored dist files
git add -f browser/dist/src/control/Control.WordMeta.js \
           browser/dist/src/layer/marker/TextInput.js \
           browser/dist/src/map/handler/Map.WOPI.js \
           browser/dist/cool.html \
           browser/dist/branding.js

# Commit and push
git commit -m "feat: update editor files and branding"
git push origin main
```

### Step 2: Pull the Existing Docker Hub Image

```bash
docker pull --platform linux/amd64 ronitgandotra/collabora-ronit-version:latest
```

### Step 3: Start a Temporary Container

```bash
docker rm -f collabora-temp 2>/dev/null || true
docker run -d --name collabora-temp \
  --platform linux/amd64 \
  ronitgandotra/collabora-ronit-version:latest
```

### Step 4: Create Missing Directories (as root)

The baked image only has `src/layer/tile/`. The other directories don't exist and must be created:

```bash
docker exec -u root collabora-temp mkdir -p \
  /usr/share/coolwsd/browser/dist/src/control \
  /usr/share/coolwsd/browser/dist/src/map/handler \
  /usr/share/coolwsd/browser/dist/src/layer/marker
```

### Step 5: Copy All 5 Files into the Container

```bash
cd ~/Desktop/Collabora-word-edittor

DIST=/usr/share/coolwsd/browser/dist

docker cp browser/dist/src/control/Control.WordMeta.js collabora-temp:$DIST/src/control/
docker cp browser/dist/src/layer/marker/TextInput.js collabora-temp:$DIST/src/layer/marker/
docker cp browser/dist/src/map/handler/Map.WOPI.js collabora-temp:$DIST/src/map/handler/
docker cp browser/dist/cool.html collabora-temp:$DIST/
docker cp browser/dist/branding.js collabora-temp:$DIST/
```

### Step 6: Verify the Files Are Correct

```bash
docker exec collabora-temp grep "brandProductName" /usr/share/coolwsd/browser/dist/branding.js
docker exec collabora-temp grep "<title>" /usr/share/coolwsd/browser/dist/cool.html
docker exec collabora-temp grep "Control.WordMeta\|Map.WOPI\|TextInput" /usr/share/coolwsd/browser/dist/cool.html
```

Expected:
```
var brandProductName = 'Stenope Editor';
<title>Stenope Editor</title>
  <script defer src="...Map.WOPI.js"></script>
  <script defer src="...Control.WordMeta.js"></script>
  <script defer src="...TextInput.js"></script>
```

### Step 7: Commit as New Image

```bash
docker commit collabora-temp ronitgandotra/collabora-ronit-version:latest
```

This takes ~2 minutes. Creates a new image with all changes baked in.

### Step 8: Push to Docker Hub

```bash
docker login
docker push ronitgandotra/collabora-ronit-version:latest
```

This takes ~5-10 minutes depending on upload speed. Wait for:
```
latest: digest: sha256:... size: ...
```

### Step 9: Clean Up Temp Container

```bash
docker rm -f collabora-temp
```

---

## Deploy to Cloud Run (Production)

After pushing to Docker Hub, force Cloud Run to pull the new image:

### Update the Service

```bash
gcloud run services update collabora-ronit-version \
  --region us-central1 \
  --image docker.io/ronitgandotra/collabora-ronit-version:latest \
  --port 9980 \
  --cpu 2 \
  --memory 2Gi \
  --timeout 300 \
  --min-instances 1 \
  --max-instances 3 \
  --update-env-vars "^|^extra_params=--o:ssl.enable=false --o:ssl.termination=true --o:net.proto=IPv4 --o:security.seccomp=false --o:mount_jail_tree=false --o:net.frame_ancestors=http://localhost:3000 https://spectacular-faun-b1b38e.netlify.app https://api.tisaproductions.com collabora-ronit-version-140170437531.us-central1.run.app:*|aliasgroup1=https://api.tisaproductions.com"
```

> **Note:** The `--image` flag forces Cloud Run to pull the updated image even though the tag name (`latest`) is the same.

### Verify Deployment

```bash
# Check HTTP response
curl -I https://collabora-ronit-version-140170437531.us-central1.run.app/hosting/discovery

# Verify branding
curl -s https://collabora-ronit-version-140170437531.us-central1.run.app/browser/dist/branding.js | head -5

# Check logs for errors
gcloud run services logs read collabora-ronit-version --region us-central1 --limit 50

# Describe service config
gcloud run services describe collabora-ronit-version --region us-central1 \
  --format="flattened(spec.template.spec.containers[0].env)"
```

### Make Public (only needed on first deploy)

```bash
gcloud run services add-iam-policy-binding collabora-ronit-version \
  --region=us-central1 \
  --member="allUsers" \
  --role="roles/run.invoker"
```

---

## Run Locally on Mac (Testing)

### Option A: Run the Baked Image (no bind mount)

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

### Option B: Switch Back to Dev Container (with bind mount)

```bash
docker stop collabora-ronit-version
docker start collabora-code
```

---

## Verification Checklist

After deploying, open the editor and verify:

- [ ] Loading screen shows **"Stenope Editor"** (not "Collabora Online Development Edition")
- [ ] Browser tab title says **"Stenope Editor"**
- [ ] About dialog shows **"Stenope Editor"** and **"Powered by Stenope.AI"**
- [ ] No welcome popup on first load
- [ ] No feedback popup
- [ ] No update notification popup
- [ ] Click-to-seek highlights the correct word (not off-by-one)
- [ ] Arrow key navigation moves one word at a time (not skipping)
- [ ] Typing is blocked during audio playback mode

---

## FAQ

### Do I need a new Docker Hub image name?

No. Push to the same `ronitgandotra/collabora-ronit-version:latest`. Docker Hub overwrites the tag.

### Why `docker exec -u root mkdir` in Step 4?

The baked image's `browser/dist/src/` only contains `layer/tile/`. The `control/`, `map/handler/`, and `layer/marker/` directories don't exist. Creating them requires root permissions inside the container.

### What if I run `./build.sh` again later?

A full build regenerates `cool.html` and `branding.js` from templates, overwriting branding. Re-run Steps 4-9 to re-apply.

### When DO I need a full `./build.sh`?

Only when changing files bundled into `bundle.js` (e.g., `CanvasTileLayer.js`, core Leaflet files). The 5 hot-swappable files listed above never need it.

### Can I do this from any machine?

Yes. The `docker cp` + `docker commit` approach works from any machine with Docker and access to your repo. No VM or `instdir` needed.
