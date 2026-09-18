#!/usr/bin/env bash
# Sent by CI over SSH using the existing repository.
set -euo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset BASH_ENV ENV CDPATH
sha=${1:-}
[[ $# == 2 && "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 64; }

repository=$2
[[ "$repository" =~ ^/[a-zA-Z0-9_./-]+$ && "$repository" != / ]] || exit 64
[[ -d "$repository" ]] || { echo "Repository missing: $repository; set MARKET_DEPLOY_PATH to the actual existing checkout." >&2; exit 66; }
repository=$(cd "$repository" && pwd -P)
[[ $(git -C "$repository" rev-parse --show-toplevel) == "$repository" ]]
env_file="$repository/market/server/.env"
[[ -f "$env_file" ]]
deploy_root="$(git -C "$repository" rev-parse --absolute-git-dir)/market-deploy"
container=tokenscowork-market-host
mkdir -p "$deploy_root"
exec 9>"$deploy_root/deploy.lock"
flock -n 9 || { echo 'Another market deployment is running' >&2; exit 75; }
mkdir -p "$deploy_root/releases" "$deploy_root/backups"
# Market is self-contained; override server-wide recursive-fetch settings.
git -C "$repository" fetch --no-recurse-submodules --prune origin '+refs/heads/master:refs/remotes/origin/master'
git -C "$repository" cat-file -e "$sha^{commit}"
# Superseded queued deployments must not roll the service back to an older commit.
[[ $(git -C "$repository" rev-parse refs/remotes/origin/master) == "$sha" ]] || {
  echo 'Commit is no longer master HEAD; deploy the latest tested workflow run.' >&2; exit 65;
}
release=$(mktemp -d "$deploy_root/releases/$sha.XXXXXX")
git -C "$repository" archive "$sha" market/server | tar -x -C "$release"
image="tokenscowork-market:$sha"
# New code is built before stopping the current service. No registry/Nginx changes.
docker build --label "org.opencontainers.image.revision=$sha" -t "$image" "$release/market/server"
old_image=$(docker inspect --format '{{.Image}}' "$container")
[[ $(docker inspect --format '{{.State.Running}}' "$container") == true ]]
stamp=$(date -u +%Y%m%dT%H%M%SZ)
rollback_image="tokenscowork-market:rollback-$stamp"
docker image tag "$old_image" "$rollback_image"

# SQLite VACUUM INTO creates a consistent snapshot including committed WAL data.
backup="market-$stamp-$sha.sqlite"
docker exec -i "$container" node --input-type=module - "$backup" <<'NODE'
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
const name = process.argv[2]
if (!/^market-[0-9TZ]+-[a-f0-9]{40}\.sqlite$/.test(name)) throw Error('Invalid backup name')
mkdirSync('/data/deploy-backups', {recursive:true,mode:0o700})
const db = new DatabaseSync('/data/market.sqlite')
db.exec('PRAGMA busy_timeout=10000')
db.exec(`VACUUM INTO '/data/deploy-backups/${name}'`)
db.close()
const snapshot = new DatabaseSync(`/data/deploy-backups/${name}`, {readOnly:true})
if (snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('Backup integrity check failed')
snapshot.close()
NODE
docker cp "$container:/data/deploy-backups/$backup" "$deploy_root/backups/$backup"
chmod 600 "$deploy_root/backups/$backup"
test -s "$deploy_root/backups/$backup"

# Keep three verified host snapshots, including this deployment's recovery point.
# Only exact deployment filenames are eligible; never recurse or follow symlinks.
prune_backups() {
  local directory=$1 current=$2 file name kept=1
  local -a names=()
  for file in "$directory"/market-*.sqlite; do
    [[ -f "$file" && ! -L "$file" ]] || continue
    name=${file##*/}
    [[ "$name" =~ ^market-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{40}\.sqlite$ ]] || continue
    [[ "$name" == "$current" ]] || names+=("$name")
  done
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    if (( kept < 3 )); then kept=$((kept + 1)); else rm -- "$directory/$name" || return; fi
  done < <(printf '%s\n' "${names[@]}" | LC_ALL=C sort -r)
}
prune_backups "$deploy_root/backups" "$backup"
# Host copy is verified above. Remove only deployment-generated temporary volume copies.
docker exec -i "$container" node --input-type=module <<'NODE'
import { readdirSync, unlinkSync } from 'node:fs'
const directory = '/data/deploy-backups'
for (const entry of readdirSync(directory, {withFileTypes:true})) {
  if (entry.isFile() && /^market-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{40}\.sqlite$/.test(entry.name)) {
    unlinkSync(`${directory}/${entry.name}`)
  }
}
NODE

compose="$release/deploy-compose.yml"
cat > "$compose" <<YAML
name: tokenscowork-market-host
services:
  market:
    image: $image
    container_name: tokenscowork-market-host
    restart: unless-stopped
    env_file: $env_file
    ports:
      - "127.0.0.1:4880:8080"
    volumes:
      - market-host-data:/data
volumes:
  market-host-data:
    external: true
    name: tokenscowork-market-host-data
YAML
health() {
  docker exec -i "$container" node --input-type=module <<'NODE'
const origin = 'http://127.0.0.1:8080'
const get = async (path, headers={}) => {
  const r=await fetch(origin+path,{headers,signal:AbortSignal.timeout(5000)})
  if (!r.ok) throw Error(`Health check ${path}: ${r.status}`)
  return r
}
await get('/admin/')
await get('/source.json')
const headers={Authorization:'Bearer '+process.env.MARKET_ADMIN_TOKEN}
await get('/api/admin/access',headers)
await get('/api/admin/subjects',headers)
NODE
}
rollback() {
  trap - ERR
  echo "Deployment failed. Restoring previous image; database backup: $backup" >&2
  # Only code is rolled back automatically. Never overwrite live data after writes.
  sed "s|image: $image|image: $rollback_image|" "$compose" > "$release/rollback-compose.yml"
  if docker compose -f "$release/rollback-compose.yml" up -d --no-build --no-deps market; then
    echo 'Previous image restarted; verify service health and migration compatibility.' >&2
  else
    echo 'CRITICAL: previous image restart failed; administrator intervention required.' >&2
  fi
  exit 1
}
trap rollback ERR
docker compose -f "$compose" up -d --no-build --no-deps market
healthy=false
for attempt in $(seq 1 12); do
  if health >/dev/null 2>&1; then healthy=true; break; fi
  sleep 5
done
[[ "$healthy" == true ]]
[[ $(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container") == "$sha" ]]
trap - ERR
printf '%s\n' "$sha" > "$deploy_root/current-sha"
printf 'Deployed market %s; backup %s; rollback image %s\n' "$sha" "$backup" "$rollback_image"
