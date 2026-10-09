#!/bin/sh
# Fixture probe: always ready (M3 integration tests).
echo '{"ready": true, "note": "smoke-ok", "checks": [{"name": "tcp", "ok": true}]}'
