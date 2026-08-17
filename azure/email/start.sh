#!/bin/sh
cd /listmonk
./listmonk --install --idempotent --yes && exec ./listmonk
