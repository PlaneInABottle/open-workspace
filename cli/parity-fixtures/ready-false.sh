#!/bin/sh
# Fixture probe: TCP-UP-but-not-ready, clean verdict (M3 integration tests).
echo '{"ready": false, "note": "kapali", "checks": [{"name": "actuator", "ok": false}]}'
exit 0
