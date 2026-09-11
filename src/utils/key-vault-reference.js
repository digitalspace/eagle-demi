'use strict';

/**
 * The literal App Service leaves behind when a Key Vault reference does not resolve.
 *
 * Its own module, with no requires of its own, so a caller that needs the check — config.js, a
 * controller, an operator script — gets it without pulling in server configuration.
 */
function isKeyVaultReference(value) {
  return typeof value === 'string' && value.trim().startsWith('@Microsoft.KeyVault(');
}

module.exports = { isKeyVaultReference };
