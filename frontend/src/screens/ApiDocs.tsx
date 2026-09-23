import { config } from '../config';
import { apiDocsTarget } from '../routes';
import { primaryButton, stack } from './controls';

/** Environments that serve the Swagger UI. Anywhere else the route is not published. */
const SWAGGER_ENVIRONMENTS = ['dev', 'test'];

export function ApiDocs() {
  const swaggerAvailable = SWAGGER_ENVIRONMENTS.includes(String(config().ENVIRONMENT || '').toLowerCase());

  // `noopener` as well as `_blank`: without it the spec page is handed a handle on this window.
  const openSwagger = () => window.open(apiDocsTarget(config().API_PATH), '_blank', 'noopener');

  return (
    <>
      <div className="screen-header">
        <div className="screen-header__text">
          <h1>API documentation</h1>
          <p>The Swagger UI the API serves itself, plus what a caller needs before the first request.</p>
        </div>
        {swaggerAvailable && (
          <button type="button" onClick={openSwagger} style={primaryButton}>
            Open Swagger UI
          </button>
        )}
      </div>

      <section className="panel panel--padded">
        <h2 className="panel__title panel__title--inline">Authenticating</h2>
        <div style={stack}>
          <div>
            <div className="cell__title">Staff and applications</div>
            <div className="cell__sub" style={{ overflowWrap: 'anywhere' }}>
              Keycloak realm <code className="cell__mono">eao-epic</code>. Applications use a service account —{' '}
              <code className="cell__mono">client_credentials</code>, then a normal bearer token.
            </div>
          </div>
          <div>
            <div className="cell__title">Callers without a Keycloak client</div>
            <div className="cell__sub" style={{ overflowWrap: 'anywhere' }}>
              A registry API key: <code className="cell__mono">{'X-Api-Key: demi_<env>_<keyId>_<secret>'}</code>,
              issued with its own roles, expiry and revocation.
            </div>
          </div>
        </div>
      </section>

      <section className="panel panel--scroll">
        <h2 className="panel__title">Roles</h2>
        <table style={{ minWidth: '40rem' }}>
          <thead>
            <tr>
              <th>Role</th>
              <th>Reads</th>
              <th style={{ width: '8rem' }}>Writes data</th>
              <th style={{ width: '9rem' }}>Admin routes</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <span className="role-chip">public</span>
              </td>
              <td className="cell--muted">published rows only</td>
              <td className="cell--muted">no</td>
              <td className="cell--muted">no</td>
            </tr>
            <tr>
              <td>
                <span className="role-chip">compliance</span>
              </td>
              <td className="cell--muted">sealed rows, on /api/sealed only</td>
              <td className="cell--muted">no</td>
              <td className="cell--muted">no</td>
            </tr>
            <tr>
              <td>
                <span className="role-chip">demi-service-read</span>
              </td>
              <td className="cell--muted">everything the ACL allows</td>
              <td className="cell--muted">no</td>
              <td className="cell--muted">no</td>
            </tr>
            <tr>
              <td>
                <span className="role-chip">demi-service-write</span>
              </td>
              <td className="cell--muted">everything the ACL allows</td>
              <td className="cell--muted">yes</td>
              <td className="cell--muted">no</td>
            </tr>
            <tr>
              <td>
                <span className="role-chips">
                  <span className="role-chip">sysadmin</span>
                  <span className="role-chip">staff</span>
                  <span className="role-chip">demi-admin</span>
                </span>
              </td>
              <td className="cell--muted">everything the ACL allows</td>
              <td className="cell--muted">yes</td>
              <td className="cell--muted">yes</td>
            </tr>
            <tr>
              <td>
                <span className="role-chip">{'project:<id>'}</span>
              </td>
              <td className="cell--muted">scope, not a privilege — narrows any role to those projects</td>
              <td className="cell--muted">no</td>
              <td className="cell--muted">no</td>
            </tr>
          </tbody>
        </table>
      </section>

      <p className="footnote">
        Ask for the least privilege that works. A privileged credential carrying a project scope is privileged within
        those projects only.
        {!swaggerAvailable &&
          ' Swagger UI is not linked here: the API serves it on dev and test only, so there is nothing to open in this environment.'}
      </p>
    </>
  );
}
