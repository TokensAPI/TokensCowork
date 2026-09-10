#!/bin/sh
set -eu

# Create a Verdaccio htpasswd entry without enabling public registration.
# Run from market/registry on the server as a user allowed to run Docker.

if [ "$#" -ne 1 ]; then
  echo "usage: $0 USERNAME" >&2
  exit 2
fi

username=$1
case "$username" in
  ''|*[!A-Za-z0-9._-]*) echo 'username must contain only letters, numbers, dot, underscore or hyphen' >&2; exit 2 ;;
esac

printf 'Password: '
stty -echo
IFS= read -r password
stty echo
printf '\n'
if [ -z "$password" ]; then echo 'password cannot be empty' >&2; exit 2; fi

# htpasswd -i reads the password as a SINGLE line from stdin and never asks for
# confirmation. Feeding it twice makes the hash cover the wrong string, and the
# resulting entry silently fails to authenticate.
entry=$(printf '%s\n' "$password" | docker run --rm -i httpd:2.4-alpine htpasswd -nBi "$username")

# Verdaccio runs as uid 10001 / gid 65533; a root-owned 600 file gives EACCES
# and hangs every login, so the file has to be chowned after rewriting it.
printf '%s\n' "$entry" | docker run --rm -i -v tokenscowork-registry-storage:/verdaccio/storage alpine:3.20 sh -c 'umask 077; touch /verdaccio/storage/htpasswd; grep -v "^$1:" /verdaccio/storage/htpasswd | grep -v "^[[:space:]]*$" > /tmp/htpasswd.new || true; cat >> /tmp/htpasswd.new; mv /tmp/htpasswd.new /verdaccio/storage/htpasswd; chown 10001:65533 /verdaccio/storage/htpasswd; chmod 600 /verdaccio/storage/htpasswd' sh "$username"
docker restart tokenscowork-registry >/dev/null
echo "created $username"
