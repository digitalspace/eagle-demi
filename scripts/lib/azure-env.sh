# shellcheck shell=bash disable=SC2034
# Sourced, not run. Sets SUBSCRIPTION and RESOURCE_GROUP for one DEMI environment; returns 1 on an
# unknown one. Used by scripts/deploy-infra.sh and scripts/apply-cosmos-index.sh.
demi_azure_env() {
  case "$1" in
    test)
      SUBSCRIPTION='7897ceb1-9a86-4639-87d7-7f9ff67142b3'
      RESOURCE_GROUP='c4b0a8-test-rg'
      ;;
    prod)
      SUBSCRIPTION='be5924ac-1083-4a1b-be92-7b444882cfd9'
      RESOURCE_GROUP='rg-demi-prod'
      ;;
    *) return 1 ;;
  esac
}
