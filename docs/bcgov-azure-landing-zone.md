# BC Gov Azure Landing Zone — rules that bite

Compacted from `bcgov/public-cloud-techdocs` (47 pages, `docs/azure/**` + `docs/welcome/**`),
fetched 2026-07-31. **Source of truth upstream**, not this file — re-pull if rule look wrong:
`https://raw.githubusercontent.com/bcgov/public-cloud-techdocs/main/<path>`. Live render:
<https://developer.gov.bc.ca/docs/default/component/public-cloud-techdocs/azure/>.

Kept: constraints that block deploy, change design, or need ticket. Dropped: tutorials, portal
click-paths, marketing, AWS pages, services DEMI never run. **Policy beats RBAC** — Owner no get
past Deny.

---

## 1. Deployment restrictions

- **Regions: Canada Central and Canada East only.** Else blocked. **Networking only in Canada
  Central** — Canada East has *no* landing-zone connectivity, and Azure AI models currently
  Canada-East-only. Both true at once: AI model in region with no network.
- Resource group must be **same region** as resources in it.
- Deny policy lists resource types that cannot be created at all.
- **HTTPS only** everywhere; **TLS 1.2** minimum.

## 2. Networking — mostly not yours

Cannot create or modify, by policy:

- **Public IPs** (standalone or on NIC).
- **VNets**, **VNet peering**, **VNet address space**, **VNet DNS settings**.
- **ExpressRoute circuits, VPN Sites, VPN/NAT/Local Gateways, Route Tables (UDRs).** UDR needs
  [service request](https://citz-do.atlassian.net/servicedesk/customer/portal/3) — SQL Managed
  Instance truly needs one, so ask *before* deploy.
- Deleting `setbypolicy` diagnostic settings (may add own).

Other network rules:

- **Every subnet needs NSG.** Portal cannot create both at once; use CLI/IaC. In Terraform use
  `azapi_resource`, not `azurerm_subnet` — that resource cannot attach NSG at creation, so policy
  rejects it.
- Subnets need **private endpoint network policies enabled**.
- **Service Endpoints denied.** Private Endpoints sanctioned path.
- **All subnets private** — no default outbound internet. Egress centrally routed through
  vWAN/firewall.
- **Spoke-to-spoke off** by default; needs reviewed request.
- Inbound **22/3389 from internet blocked**. Use Bastion. **Do not enable JIT VM Access** — built
  for public-IP VMs, its NSG rules break Bastion.
- Public exposure = **HTTPS through Application Gateway** only: `WAF_v2` SKU, WAF in
  **Prevention** mode, request-body inspection and bot protection on.

## 3. Private endpoints and DNS — the part that wastes days

- Most PaaS **private-endpoint-only**. Creating one with public access, or turning public access on
  later, denied.
- **Private DNS Zones centrally owned** (Connectivity subscription). You **denied** creating own
  `privatelink.*` zone for supported service.
- In portal, set **"Integrate with private DNS zone" = No**. `DeployIfNotExists` policy attaches
  zone group named **`deployedByPolicy`** and writes `A-record` for you.
- ⏱ **`A-record` appears about TEN MINUTES after private endpoint.** Before that name resolves to
  service PUBLIC address — which policy disabled — so fails as connection timeout that read exactly
  like missing DNS zone. **Wait before diagnosing.** (Routing settles separately, well under
  minute. Two different not-ready states.)
- ❌ **Linking own Private DNS Zone to VNet does not work** — every query goes to central Private
  DNS Resolver, which never consults it. No self-service DNS fix.
- Truly missing zone (third-party services, e.g. Confluent): **support request**, Public Cloud team
  attaches it to central resolver.
- Known platform bug: **Azure OpenAI `A-records` sometimes not created** — open ticket.
- **Multiple private endpoints on one resource is footgun**: policy automation rewrites single
  `A-record` to newest endpoint, and deleting that endpoint can remove record while other endpoint
  still exists — DNS then resolves to nothing.
- Terraform: policy adds `privateDnsZoneGroups/deployedByPolicy` block Terraform wants to destroy.
  Add `lifecycle { ignore_changes = [private_dns_zone_group] }`.
- Private-only means **portal tools that call data plane from your browser stop working** (SQL
  Query Editor, Data Factory Studio). Reach them from VM inside VNet via Bastion.

## 4. Azure AI services

- 🚩 **Provisioning of Azure AI services is managed through the AI Services Hub.** Request access
  at <https://bcgov.github.io/ai-hub-tracking/>, describe what you build. Same page for enhancement
  requests, bugs, architecture guidance.
- **AI Search outbound** (indexer data sources, skillsets) needs **shared private link** — distinct
  from inbound private endpoint. Documented, expected pattern.
- Cognitive Services / OpenAI / ML attract extra Enterprise Scale guardrails: permitted SKUs,
  managed-identity auth, storage config, outbound network. Configure at max security from start;
  retrofit fails deploys.
- Private-only AI services typically administered from VM in VNet (Bastion, minimum SKU
  **Developer**, needs no dedicated subnet).

## 5. Identity, secrets, data

- **Managed identity first.** App registration only for human sign-in, multi-tenant, or M365
  integration — and **must be requested through My Service Centre**; self-registration off.
- Client secrets/certs **must live in Key Vault with rotation**. Hard-coded credentials in source
  or pipeline variables prohibited.
- Key Vault: soft delete + purge protection on, firewall **Deny All**, **RBAC only** (access
  policies denied), secrets/keys need expiry (secrets default max 90 days).
- **Customer-managed keys** required for many services — Storage, **Cosmos DB**, SQL TDE, AKS
  disks, **Cognitive Services**, Data Factory, Service Bus, Synapse, more.
- Storage: no custom domains, no SFTP, no local users.
- Access via Entra groups named `DO_PuC_Azure_Live_{LicensePlate}_{Role}`. Product Owner manages
  membership, can delegate.
- **Control plane ≠ data plane.** ARM RBAC no grant data access; separate roles.

## 6. Cost

- Platform auto-applies `account_coding`, `billing_group`, `ministry_name` from subscription tags.
  Own tags additive — and only tag usage **from moment applied**, never retroactive.
- Policies **audit** unattached disks, unused public IPs, empty App Service plans.

## 7. Getting help

- **[Jira Service Management portal 3](https://citz-do.atlassian.net/servicedesk/customer/portal/3)**
  — preferred. Quote 6-character **license plate** (management group / subscription name under
  `BCGov-Managed-LZ > BCGov-Managed-LZ-Live > Landing Zones`).
- Teams channel `CloudAzure-howto`; Microsoft Enterprise Support for vendor issues (not available
  on third-party vendor landing zones).
- Policy exceptions *may* be granted, but need formal review and justification.

---

## What this cost DEMI already (2026-07-31)

Measured, not theoretical — full detail in `MIGRATION.md` §G.

- `Deny-PublicPaaSEndpoints` / `Deny-CognitiveSearch-PublicEndpoint` rejected AI Search deploy
  outright until `publicNetworkAccess: 'Disabled'` + private endpoint. No start-public-then-lock-
  down path.
- Ten-minute `A-record` delay misread as missing `privatelink.search.windows.net` zone, nearly
  became support ticket and gateway design (APIM/Front Door, $125–2,800/mo) for problem that fixed
  itself by waiting.
- AI Services Hub request **not** submitted before creating `demi-search-dev`. Open item in
  `TODO.md`.
- Debugging private-only service from workstation impossible by design. What works here: **auth
  minted outside, network from inside** — token from `az account get-access-token` handed to
  request issued from App Service container.