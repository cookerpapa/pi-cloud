# Pi Managed Agents project identity

The owner selected **Pi Managed Agents** as the public name. The repository is
[cookerpapa/pi-managed-agents](https://github.com/cookerpapa/pi-managed-agents),
with the description “Self-hosted infrastructure for managed agents, powered by Pi.”
Its GitHub repository ID remains 1310455099; the former `pi-cloud` URL returns a
301 redirect to the renamed repository. The local `origin` uses the new URL.

README, documentation entry points, browser title/description, login, sidebar,
administration and English composer branding use the new name. Existing package
scopes, protocol types, environment keys, persistent browser keys and deployed
resource identifiers remain technical identities. This is a branding release,
with no storage, execution, licensing or authority migration. Historical reports
retain the names used by their recorded releases and copyright notices are preserved.

## Verification and publication

- Web type checks, 274 scoped Web/release tests, browser presentation, queue,
  Skill and history-layout checks passed. One existing administrator-render test
  still expected the old name; that assertion was updated and revalidated.
- The built preview and deployed site each passed six checks: login, member
  sidebar and administration at 1280 px and 390 px. The mobile sidebar was opened
  before measurement. Branding and page width fit their containers. The member
  chrome uses an explicit client-side view fixture over authenticated read-only
  requests; login and administration exercise their real page flows.
- Web image build and release scan passed. `managed-agents-brand-20261110-r1`
  (source `0827efee`) was published through the maintained Web scope at application
  Helm revision 156. Full manifest comparison permits only the Web image change.
- Post-publication comparison confirmed 34 backend Pods/container identities and
  both existing VMs were unchanged. The new Web Pod served the renamed title and
  product chrome. No model calls or test Runs were needed for this presentation change.

The Web scope now explicitly includes its static HTML entry page; API client,
protocol, proxy, dependencies and chart changes remain excluded. Fault-case
manifests are classified as operator/test inputs, not deployed runtime code.
Existing deployment guards and image provenance checks remain in force.

Private evidence is under
`deploy/production/runtime/releases/managed-agents-brand-20261110-r1/acceptance/`.
An already-open browser page loads the new assets on refresh.
