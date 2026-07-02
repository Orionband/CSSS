#!/bin/sh
set -e

for dir in /data /app/logs /app/captures; do
    mkdir -p "$dir"
    if ! chown csss:csss "$dir" 2>/dev/null; then
        echo "Warning: could not chown $dir (volume permissions may need attention)" >&2
    fi
done

exec su-exec csss "$@"
