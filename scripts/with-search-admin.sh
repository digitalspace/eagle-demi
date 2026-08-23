#!/usr/bin/env bash
#
# Run a command with the app identity temporarily holding Search Service Contributor, then revoke.
#
# WHY THE GRANT IS TEMPORARY, since the obvious question is why not just leave it. The search data
# plane is private-endpoint-only, so the only thing that can reach it is code running inside the app
# container, and that code authenticates as `demi-identity-test` — the identity the INTERNET-FACING
# API runs as. A standing grant would let a bug or a compromise in the public API delete an index.
# That matters more here than it normally would: `chunks` is ~1.13M rows / ~3.95 GB, it is the only
# extracted copy, the backup is Periodic on an 8-HOUR retention, and the restore has never been
# tested. Granting a human's own account instead does not help — a laptop cannot reach the data
# plane at all.
#
# WHAT THIS FIXES is the hand-work, not the posture: three separate index changes have each done
# `az role assignment create` … work … `az role assignment delete` by hand, and the failure that
# costs something is a grant left standing because the middle step errored. The revoke runs from a
# trap, so it also fires on a failure, on Ctrl-C, and on a dropped tunnel.
#
# The app identity permanently holds **Search Index Data Contributor**, which covers DOCUMENTS and
# not DEFINITIONS. Creating or widening an index or an indexer needs **Search Service Contributor**
# (7ca78c08-252a-4471-8644-bb5ff32d4ba0). It is granted at the SERVICE scope, never the resource
# group. Revocability is not assumed: the `c4b0a8` ABAC condition restricts roleAssignments write
# and delete to six role GUIDs and this is on neither list, proven by a grant/revoke cycle.
#
# Usage — the command runs on THIS machine, so the usual shape is an ssh into the container:
#
#   scripts/with-search-admin.sh -- \
#     sshpass -p "$CONTAINER_SSH_PASSWORD" ssh -c aes256-cbc -m hmac-sha1 -p 50123 root@127.0.0.1 \
#     'cd /home/site/wwwroot && node src/scripts/apply-search-definitions.js --live --only projects'
#
#   RG=c4b0a8-test-rg SERVICE=demi-search-test IDENTITY=demi-identity-test \
#     scripts/with-search-admin.sh -- <command>
#
# Bring the tunnel up first (see README, "Running anything against the database").
set -euo pipefail

# The `az` seam exists so the revoke-on-failure path is testable without touching a real tenant —
# same shape as PULL_SSH_CMD in pull-from-container.sh. A trap nobody can exercise is a trap nobody
# knows works.
AZ="${AZ:-az}"

SUBSCRIPTION="${SUBSCRIPTION:-7897ceb1-9a86-4639-87d7-7f9ff67142b3}"
RG="${RG:-c4b0a8-test-rg}"
SERVICE="${SERVICE:-demi-search-test}"
IDENTITY="${IDENTITY:-demi-identity-test}"

# Search Service Contributor. The built-in GUID is stable across clouds and tenants.
ROLE_ID='7ca78c08-252a-4471-8644-bb5ff32d4ba0'

if [[ "${1:-}" == "--" ]]; then shift; fi
if [[ $# -eq 0 ]]; then
  echo "usage: $0 -- <command...>" >&2
  exit 2
fi

SCOPE="/subscriptions/${SUBSCRIPTION}/resourceGroups/${RG}/providers/Microsoft.Search/searchServices/${SERVICE}"

PRINCIPAL_ID="$("$AZ" identity show -g "$RG" -n "$IDENTITY" --query principalId -o tsv)"
if [[ -z "$PRINCIPAL_ID" ]]; then
  echo "with-search-admin: could not resolve principalId for $IDENTITY in $RG" >&2
  exit 1
fi

ASSIGNMENT_ID=''

# Revoke from a trap, so it runs on success, on failure, and on Ctrl-C. A grant left standing
# because the middle step died is the failure this script exists to prevent, and it is exactly the
# case a plain three-command sequence gets wrong.
#
# EXIT alone, not `EXIT INT TERM` — measured on bash 5.2.15: the EXIT trap runs on SIGTERM and on
# SIGINT too, so listing the signals adds nothing and makes the handler fire TWICE (once for the
# signal, once on the way out), which prints a spurious REVOKE FAILED on the second,
# already-deleted assignment. Adding them and then needing a `trap -` to undo the double-fire is a
# net loss.
revoke() {
  local status=$?
  if [[ -n "$ASSIGNMENT_ID" ]]; then
    echo "with-search-admin: revoking" >&2
    # `|| true`: a failed revoke must not mask the command's own exit status, and it must still be
    # reported loudly rather than swallowed.
    "$AZ" role assignment delete --ids "$ASSIGNMENT_ID" >/dev/null 2>&1 || {
      echo "with-search-admin: REVOKE FAILED — remove it by hand:" >&2
      echo "  az role assignment delete --ids $ASSIGNMENT_ID" >&2
    }
  fi
  exit "$status"
}
trap revoke EXIT

echo "with-search-admin: granting Search Service Contributor on $SERVICE to $IDENTITY" >&2
ASSIGNMENT_ID="$("$AZ" role assignment create \
  --role "$ROLE_ID" \
  --assignee-object-id "$PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --scope "$SCOPE" \
  --query id -o tsv)"

# The grant is not readable the instant it is created. Poll rather than sleeping a guessed interval:
# a fixed sleep is either too short (the command 403s) or wastes time on every run.
for _ in $(seq 1 20); do
  if "$AZ" role assignment list --scope "$SCOPE" --query "[?id=='${ASSIGNMENT_ID}'].id" -o tsv \
     2>/dev/null | grep -q .; then
    break
  fi
  sleep 3
done

"$@"
