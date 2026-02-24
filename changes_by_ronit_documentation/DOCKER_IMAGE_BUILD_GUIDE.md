# Collabora Docker Image Build Guide (Full Source Build)

This guide explains how to build a fresh Docker image of this repo with all custom changes included, especially bundled browser changes (for example `CanvasTileLayer.js`).

## When to Use This Guide

Use this guide when:
- You want a fully self-contained image with your custom code baked in.
- You changed files that are bundled into `browser/dist/bundle.js`.
- You do not want runtime bind-mount dependency on local `browser/dist`.

## Recommended VM Requirements

Minimum (works, but slower, may need cleanup during final image export):
- CPU: 4 vCPU
- RAM: 8 GB
- Disk: 50 GB SSD

Recommended:
- CPU: 8 vCPU
- RAM: 16 GB
- Disk: 80 GB SSD

Notes:
- Very small VMs (2 vCPU / 2 GB RAM) can take many hours and may fail.
- Keep at least 20 GB free during build.
- Even on 50 GB disk, you can still hit `no space left on device` at final Docker unpack. This is recoverable by deleting `docker/from-source/builddir` and pruning Docker cache.

## 1. Start From Scratch (SSH + Repo Access)

Generate SSH key:

```bash
ssh-keygen -t ed25519 -C "your-email@example.com"
cat ~/.ssh/id_ed25519.pub
```

Add the printed public key to GitHub:
- GitHub -> Settings -> SSH and GPG keys -> New SSH key

Test GitHub SSH access:

```bash
ssh -T git@github.com
```

Expected:
- `You've successfully authenticated, but GitHub does not provide shell access.`

## 2. System Setup (Debian 12 / GCP VM)

### Install Docker

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg lsb-release

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo systemctl enable --now docker
sudo usermod -aG docker $USER
newgrp docker
docker version
```

### Install Build Dependencies

```bash
sudo apt-get update
sudo apt-get install -y \
  gettext locales rsync file \
  build-essential pkg-config autoconf automake libtool m4 \
  bison flex gperf nasm xsltproc zip unzip ccache \
  python3 python3-lxml python3-polib perl \
  libssl-dev libkrb5-dev libcap-dev libpam-dev libzstd-dev libpng-dev libcppunit-dev \
  libpoco-dev libxml2-dev libxslt1-dev zlib1g-dev
```

## 3. Clone Repo

```bash
git clone git@github.com:RonitGandotra05/Collabora-word-edittor.git ~/Collabora-word-edittor
cd ~/Collabora-word-edittor
git pull origin main
```

## 4. Verify VM Capacity

```bash
lscpu
free -h
df -h
lsblk -o NAME,ROTA,SIZE,MODEL
```

Optional (if RAM is low), add swap:

```bash
sudo fallocate -l 8G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

## 5. Build a New Image with Your Changes

Run from:

```bash
cd /home/ronitgandotra/Collabora-word-edittor/docker/from-source
```

Set custom image name and build:

```bash
export DOCKER_HUB_REPO=collabora-ronit-version
export DOCKER_HUB_TAG=latest
export COLLABORA_ONLINE_REPO=/home/ronitgandotra/Collabora-word-edittor
export COLLABORA_ONLINE_BRANCH=main
./build.sh
```

Behavior notes:
- `online-branding` clone can fail; this is expected and non-blocking for OSS build.
- Build is long because it compiles LibreOffice core and online from source.

If prompted during `online-branding` clone:

```text
Are you sure you want to continue connecting (yes/no/[fingerprint])?
```

Type:

```text
no
```

and continue.

## 6. What This Build Includes

This flow builds a fresh image from your current repo source (`main` in this setup), including:
- Browser bundle rebuild (`dist/bundle.js`)
- Changes in bundled files like `browser/src/layer/tile/CanvasTileLayer.js`
- Server/runtime binaries and frontend assets copied into `instdir`
- Final image assembled from `docker/from-source/Debian`

This is the correct path when you need complete baked changes, not only runtime overrides.

## 7. Verify Image

```bash
docker images | grep collabora-ronit-version
```

Expected image tag:
- `collabora-ronit-version:latest`

## 8. Run the Built Image

```bash
docker rm -f collabora-ronit-version 2>/dev/null || true

docker run -d --name collabora-ronit-version \
  -p 9980:9980 \
  --cap-add MKNOD \
  -e aliasgroup1=https://.* \
  -e extra_params="--o:ssl.enable=false --o:ssl.termination=false --o:security.seccomp=false --o:mount_jail_tree=false" \
  collabora-ronit-version:latest
```

Important:
- Do not bind-mount `browser/dist` if you want pure image behavior.
- A bind mount overrides files baked into the image.
- The `security.seccomp=false` and `mount_jail_tree=false` flags are runtime stability flags. They fixed black-screen/blank-editor startup in this setup when seccomp filter init failed.

## 9. Live Monitoring During Build

```bash
ps -ef | grep -E "build.sh|make|g\\+\\+" | grep -v grep
du -sh /home/ronitgandotra/Collabora-word-edittor/docker/from-source/builddir
docker system df
```

## 10. Common Errors and Fixes

### `openssl/opensslv.h: No such file or directory`

Install:
```bash
sudo apt-get install -y libssl-dev
```

### `could not find function 'gss_init_sec_context' required for GSSAPI`

Install:
```bash
sudo apt-get install -y libkrb5-dev
```

### `msgfmt not found. Install GNU gettext`

Install:
```bash
sudo apt-get install -y gettext
```

### Editor opens but document area is black/blank (runtime seccomp issue)

Symptoms:
- UI opens but document area stays black/blank.
- Container logs show seccomp errors and kit child failures (for example `Failed to install seccomp syscall filter`).

Fix used here (no rebuild needed, just restart container with runtime flags):

```bash
docker rm -f collabora-ronit-version 2>/dev/null || true
docker run -d --name collabora-ronit-version \
  -p 9980:9980 \
  --cap-add MKNOD \
  -e aliasgroup1=https://.* \
  -e extra_params="--o:ssl.enable=false --o:ssl.termination=false --o:security.seccomp=false --o:mount_jail_tree=false" \
  collabora-ronit-version:latest
```

Why it helped:
- `--o:security.seccomp=false` prevents startup failure when seccomp filter installation is unsupported/failing in the host runtime.
- `--o:mount_jail_tree=false` avoids jail mount behavior that can fail in some Docker Desktop/VM setups.
- Result in this build: editor stopped showing black screen and loaded documents.

### `no space left on device` during final Docker export/unpack

Typical error:

```text
failed to extract layer ... write /var/lib/containerd/...: no space left on device
```

Why this happens:
- Full source build creates huge intermediates in `docker/from-source/builddir` (often 20-40+ GB).
- Docker build cache and containerd layers also consume space.
- Final image export/unpack needs additional temporary space.
- This can happen even if the compile succeeded and even on 50 GB root disk.

How to diagnose:

```bash
df -h
docker system df -v
du -sh /home/ronitgandotra/Collabora-word-edittor/docker/from-source/builddir
du -sh /home/ronitgandotra/Collabora-word-edittor/docker/from-source/instdir
sudo du -sh /var/lib/docker
sudo du -sh /var/lib/containerd
```

Recovery steps (safe and proven):

```bash
# 1) Prune Docker cache and unused objects
docker builder prune -af
docker image prune -af
docker container prune -f
docker volume prune -f

# 2) Remove compile intermediates (safe once build artifacts are in instdir)
rm -rf /home/ronitgandotra/Collabora-word-edittor/docker/from-source/builddir

# 3) Verify free space and keep instdir
df -h
du -sh /home/ronitgandotra/Collabora-word-edittor/docker/from-source/instdir
```

Important safety note:
- Safe to delete: `docker/from-source/builddir`
- Do NOT delete: `docker/from-source/instdir` (required for final image build stage)

Rebuild final image only (no full recompile) after cleanup:

```bash
cd /home/ronitgandotra/Collabora-word-edittor/docker/from-source
cp ../from-packages/scripts/start-collabora-online.sh .
docker build --no-cache -t collabora-ronit-version:latest -f Debian .
```

This works because:
- `instdir` already contains compiled and installed outputs from the successful build.
- Only Docker packaging is retried.

If still low on space:
- Increase VM disk size (recommended 80-100 GB for smoother iterations).
- Keep at least ~20 GB free before final Docker export stage.

### Build interrupted by Ctrl+C

Rerun:
```bash
cd /home/ronitgandotra/Collabora-word-edittor/docker/from-source
./build.sh
```

If Poco got corrupted:
```bash
rm -rf /home/ronitgandotra/Collabora-word-edittor/docker/from-source/builddir/poco-1.12.5p2-all \
       /home/ronitgandotra/Collabora-word-edittor/docker/from-source/builddir/poco
./build.sh
```

## 11. Clean Up Old Containers/Images (Optional)

```bash
docker rm -f collabora collabora-custom collabora-ronit-version 2>/dev/null || true
docker image prune -f
```

## 12. Push Image to Docker Hub

After building locally on VM, login and push:

```bash
docker login
docker tag collabora-ronit-version:latest ronitgandotra/collabora-ronit-version:latest
docker push ronitgandotra/collabora-ronit-version:latest
```

Expected success output includes:
- `latest: digest: sha256:...`

Check local image size:

```bash
docker images collabora-ronit-version:latest
docker image inspect collabora-ronit-version:latest --format='{{.Size}}'
```

## 13. Use the Pushed Image on Mac

### A) Intel Mac (amd64)

```bash
docker pull ronitgandotra/collabora-ronit-version:latest
```

### B) Apple Silicon Mac (arm64) - important

This image was built as `linux/amd64` on VM, so on Apple Silicon you must run with emulation:

```bash
docker pull --platform linux/amd64 ronitgandotra/collabora-ronit-version:latest
```

If you do not specify platform, you may get:

```text
no matching manifest for linux/arm64/v8 in the manifest list entries
```

### C) Run on Mac (switch from existing container on port 9980)

```bash
docker stop collabora-code
docker rm -f collabora-ronit-version 2>/dev/null || true

docker run -d --name collabora-ronit-version \
  --platform linux/amd64 \
  -p 9980:9980 \
  --cap-add MKNOD \
  -e 'aliasgroup1=https://.*' \
  -e 'extra_params=--o:ssl.enable=false --o:ssl.termination=false --o:security.seccomp=false --o:mount_jail_tree=false' \
  ronitgandotra/collabora-ronit-version:latest
```

Verify:

```bash
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}"
docker logs --tail=100 collabora-ronit-version
```

Switch back to original image:

```bash
docker stop collabora-ronit-version
docker start collabora-code
```

Notes:
- Two containers cannot bind the same host port at the same time (`9980`).
- For zsh, keep env values quoted (for example `'aliasgroup1=https://.*'`) to avoid parse errors.

## 14. Key Difference: `from-packages` vs `from-source`

- `docker/from-packages`: faster, package-based image; does not fully rebuild bundled frontend internals from your source tree.
- `docker/from-source`: full compile from source; required for bundled browser changes.

## 15. Branding Customization (Stenope Editor)

The Collabora branding is controlled by `browser/dist/cool.html`. This file is gitignored by default, so force-add it:

```bash
git add -f browser/dist/cool.html
```

### What was changed

| Location | Before | After |
|---|---|---|
| `<title>` (line 3) | `Online Editor` | `Stenope Editor` |
| About dialog `<h1>` (line 165) | `Collabora Online` | `Stenope Editor` |
| Copyright text (line 186) | `Copyright © 2026, Collabora Productivity Limited.` | `Powered by Stenope.AI` |

**`browser/dist/branding.js`** — Controls the loading screen splash text:

| Variable | Before | After |
|---|---|---|
| `brandProductName` | `Collabora Online Development Edition (CODE)` | `Stenope Editor` |
| `brandProductURL` | `https://www.collaboraonline.com/code/` | `https://stenope.ai` |

### Important caveat

A full `./build.sh` regenerates `cool.html` from the template `browser/html/cool.html.m4`, which **overwrites** branding changes. After a full rebuild, re-apply the branding:

```bash
cp browser/dist/cool.html.branded browser/dist/cool.html
```

Or edit the source template at `browser/html/cool.html.m4` to make branding permanent across full rebuilds.

## 16. Fast Update: Hot-Swappable Files (No Full Rebuild)

Some files are loaded as separate `<script>` tags in `cool.html` and do **not** require a full `./build.sh`. They can be updated by copying to `instdir` and rebuilding only the final Docker layer.

### Hot-swappable files

| File | Purpose |
|---|---|
| `browser/dist/src/map/handler/Map.WOPI.js` | WOPI message handler, audio shortcut interceptor |
| `browser/dist/src/layer/marker/TextInput.js` | Text input handler, audio playback editing guard |
| `browser/dist/src/control/Control.WordMeta.js` | Word metadata, timestamp navigation, highlighting |
| `browser/dist/cool.html` | Page template, branding |
| `browser/dist/branding.js` | Loading screen product name, logo URL |

### Step-by-step: Update server image without full recompile

**1. Copy source to dist (on Mac):**

```bash
cd ~/Desktop/Collabora-word-edittor
cp browser/src/control/Control.WordMeta.js browser/dist/src/control/
cp browser/src/layer/marker/TextInput.js browser/dist/src/layer/marker/
cp browser/src/map/handler/Map.WOPI.js browser/dist/src/map/handler/
```

**2. Commit and push:**

```bash
git add -f browser/dist/src/control/Control.WordMeta.js \
           browser/dist/src/layer/marker/TextInput.js \
           browser/dist/src/map/handler/Map.WOPI.js \
           browser/dist/cool.html
git commit -m "update hot-swappable editor files"
git push origin main
```

**3. On VM: pull and copy into instdir:**

```bash
ssh your-vm
cd ~/Collabora-word-edittor
git pull origin main

DIST_DIR=$(find docker/from-source/instdir -name "cool.html" -type f | head -1 | xargs dirname)
cp browser/dist/src/control/Control.WordMeta.js "$DIST_DIR/src/control/"
cp browser/dist/src/layer/marker/TextInput.js "$DIST_DIR/src/layer/marker/"
cp browser/dist/src/map/handler/Map.WOPI.js "$DIST_DIR/src/map/handler/"
cp browser/dist/cool.html "$DIST_DIR/"
```

**4. Rebuild final Docker layer only (~2 min):**

```bash
cd ~/Collabora-word-edittor/docker/from-source
cp ../from-packages/scripts/start-collabora-online.sh .
docker build --no-cache -t collabora-ronit-version:latest -f Debian .
```

**5. Tag, push, and pull on Mac:**

```bash
# On VM
docker tag collabora-ronit-version:latest ronitgandotra/collabora-ronit-version:latest
docker push ronitgandotra/collabora-ronit-version:latest

# On Mac
docker pull --platform linux/amd64 ronitgandotra/collabora-ronit-version:latest
```

### When you DO need a full `./build.sh`

Only when changing files bundled into `bundle.js` (e.g., `CanvasTileLayer.js`, core Leaflet files). The 4 hot-swappable files above never need it.
