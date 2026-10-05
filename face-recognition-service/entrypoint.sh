#!/bin/sh
# Railway mounts volumes as root, and a mount hides anything the image did at
# build time, so the enrollment folder is not writable by the unprivileged
# "app" user on first boot. Fix ownership of that one folder, then drop root
# before starting the service, so image decoding never runs as root.
set -eu

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$KNOWN_FACES_DIR"
  chown -R app:app "$KNOWN_FACES_DIR"
  chmod 700 "$KNOWN_FACES_DIR"
  exec setpriv --reuid=app --regid=app --init-groups --no-new-privs "$@"
fi

# Already unprivileged (e.g. started with --user): nothing to fix, just run.
exec "$@"
