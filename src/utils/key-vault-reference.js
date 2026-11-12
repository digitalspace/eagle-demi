'use strict';

/**
 * The literal App Service leaves behind when a Key Vault reference does not resolve. No requires,
 * so config.js and scripts can use it without loading server config.
 */
function isKeyVaultReference(value) {
  return typeof value === 'string' && value.trim().startsWith('@Microsoft.KeyVault(');
}

module.exports = { isKeyVaultReference };
