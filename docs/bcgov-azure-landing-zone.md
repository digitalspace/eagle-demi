# BC Gov Azure Landing Zone — rules that bite

Compacted from `bcgov/public-cloud-techdocs` (47 pages, `docs/azure/**` + `docs/welcome/**`),
fetched 2026-07-31. **Source of truth is upstream**, not this file — re-pull if a rule looks wrong:
`https://raw.githubusercontent.com/bcgov/public-cloud-techdocs/main/<path>`. Live rendering:
<https://developer.gov.bc.ca/docs/default/component/public-cloud-techdocs/azure/>.

Kept: constraints that block a deployment, change a design, or need a ticket. Dropped: tutorials,
portal click-paths, marketing, AWS pages, services DEMI will never run. **Policy beats RBAC** —
Owner does not let you past a Deny.

---

## 1. Deployment restrictions

- **Regions: Canada Central and Canada East only.** Anything else is blocked. **Networking is
  provided only in Canada Central** — Canada East has *no* landing-zone connectivity, and Azure AI
  models are currently Canada-East-only. Both facts at once: an AI model in the region that has no
  network.
- Resource group must be in the **same region** as the resources in it.
- A Deny policy lists resource types that cannot be created at all.
- **HTTPS only** everywhere; **TLS 1.2** minimum.

## 2. Networking — mostly not yours

Cannot create or modify, by policy:

- **Public IPs** (standalone or on a NIC).
- **VNets**, **VNet peering**, **VNet address space**, **VNet DNS settings**.
- **ExpressRoute circuits, VPN Sites, VPN/NAT/Local Gateways, Route Tables (UDRs).** A UDR needs a
  [service request](https://citz-do.atlassian.net/servicedesk/customer/portal/3) — SQL Managed
  Instance genuinely needs one, so ask *before* deploying.
- Deleting the `setbypolicy` diagnostic settings (you may add your own).

Other network rules:

- **Every subnet needs an NSG.** The portal cannot create both at once; use CLI/IaC. In Terraform
  use `azapi_resource`, not `azurerm_subnet` — that resource cannot attach an NSG at creation, so
  policy rejects it.
- Subnets must have **private endpoint network policies enabled**.
- **Service Endpoints are denied.** Private Endpoints are the sanctioned path.
- **All subnets are private** — no default outbound internet. Egress is centrally routed through
  the vWAN/firewall.
- **Spoke-to-spoke is off** by default; needs a reviewed request.
- Inbound **22/3389 from internet is blocked**. Use Bastion. **Do not enable JIT VM Access** — it
  is built for public-IP VMs and its NSG rules break Bastion.
- Public exposure is **HTTPS through Application Gateway** only: `WAF_v2` SKU, WAF in
  **Prevention** mode, request-body inspection and bot protection on.

## 3. Private endpoints and DNS — the part that wastes days

- Most PaaS is **private-endpoint-only**. Creating one with public access, or turning public access
  on later, is denied.
- **Private DNS Zones are centrally owned** (Connectivity subscription). You are **denied**
  creating your own `privatelink.*` zone for a supported service.
- In the portal, set **"Integrate with private DNS zone" = No**. A `DeployIfNotExists` policy
  attaches a zone group named **`deployedByPolicy`** and writes the `A-record` for you.
- ⏱ **The `A-record` appears about TEN MINUTES after the private endpoint.** Before that the name
  resolves to the service's PUBLIC address — which policy has disabled — so it fails as a
  connection timeout that reads exactly like a missing DNS zone. **Wait before diagnosing.**
  (Routing settles separately, in well under a minute. Two different not-ready states.)
- ❌ **Linking your own Private DNS Zone to the VNet does not work** — every query goes to the
  central Private DNS Resolver, which never consults it. There is no self-service DNS fix.
- Genuinely missing zone (third-party services, e.g. Confluent): **support request**, and the
  Public Cloud team attaches it to the central resolver.
- Known platform bug: **Azure OpenAI `A-records` sometimes are not created** — open a ticket.
- **Multiple private endpoints on one resource is a footgun**: policy automation rewrites the
  single `A-record` to the newest endpoint, and deleting that endpoint can remove the record while
  the other endpoint still exists — DNS then resolves to nothing.
- Terraform: policy adds a `privateDnsZoneGroups/deployedByPolicy` block Terraform wants to
  destroy. Add `lifecycle { ignore_changes = [private_dns_zone_group] }`.
- Private-only means **portal tools that call the data plane from your browser stop working**
  (SQL Query Editor, Data Factory Studio). Reach them from a VM inside the VNet via Bastion.

## 4. Azure AI services

- 🚩 **Provisioning of Azure AI services is managed through the AI Services Hub.** Request access
  at <https://bcgov.github.io/ai-hub-tracking/>, describing what you are building. Same page for
  enhancement requests, bugs, and architecture guidance.
- **AI Search outbound** (indexer data sources, skillsets) requires a **shared private link** —
  distinct from the inbound private endpoint. This is the documented, expected pattern.
- Cognitive Services / OpenAI / ML attract extra Enterprise Scale guardrails: permitted SKUs,
  managed-identity auth, storage config, outbound network. Configure at maximum security from the
  start; retrofitting fails deployments.
- Private-only AI services are typically administered from a VM in the VNet (Bastion, minimum SKU
  **Developer**, which needs no dedicated subnet).

## 5. Identity, secrets, data

- **Managed identity first.** An app registration is only for human sign-in, multi-tenant, or M365
  integration — and **must be requested through My Service Centre**; self-registration is off.
- Client secrets/certs **must live in Key Vault with rotation**. Hard-coded credentials in source
  or pipeline variables are prohibited.
- Key Vault: soft delete + purge protection on, firewall **Deny All**, **RBAC only** (access
  policies are denied), secrets/keys need expiry (secrets default max 90 days).
- **Customer-managed keys** are required for many services — Storage, **Cosmos DB**, SQL TDE, AKS
  disks, **Cognitive Services**, Data Factory, Service Bus, Synapse, and more.
- Storage: no custom domains, no SFTP, no local users.
- Access via Entra groups named `DO_PuC_Azure_Live_{LicensePlate}_{Role}`. Product Owner manages
  membership and can delegate.
- **Control plane ≠ data plane.** ARM RBAC does not grant data access; those are separate roles.

## 6. Cost

- Platform auto-applies `account_coding`, `billing_group`, `ministry_name` from subscription tags.
  Your own tags are additive — and only tag usage **from the moment they are applied**, never
  retroactively.
- Policies **audit** unattached disks, unused public IPs, empty App Service plans.

## 7. Getting help

- **[Jira Service Management portal 3](https://citz-do.atlassian.net/servicedesk/customer/portal/3)**
  — preferred. Quote the 6-character **license plate** (management group / subscription name under
  `BCGov-Managed-LZ > BCGov-Managed-LZ-Live > Landing Zones`).
- Teams channel `CloudAzure-howto`; Microsoft Enterprise Support for vendor issues (not available
  on third-party vendor landing zones).
- Exceptions to policy *may* be granted, but need formal review and justification.

---

## What this cost DEMI already (2026-07-31)

Measured, not theoretical — full detail in `MIGRATION.md` §G.

- `Deny-PublicPaaSEndpoints` / `Deny-CognitiveSearch-PublicEndpoint` rejected the AI Search deploy
  outright until `publicNetworkAccess: 'Disabled'` + a private endpoint. There is no
  start-public-then-lock-down path.
- The ten-minute `A-record` delay was misread as a missing `privatelink.search.windows.net` zone,
  and nearly became a support ticket and a gateway design (APIM/Front Door, $125–2,800/mo) for a
  problem that fixed itself by waiting.
- The AI Services Hub request was **not** submitted before creating `demi-search-dev`. Open item
  in `TODO.md`.
- Debugging a private-only service from a workstation is impossible by design. What works here:
  **auth minted outside, network from inside** — a token from `az account get-access-token` handed
  to a request issued from the App Service container.
