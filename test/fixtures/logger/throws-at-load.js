'use strict';

// Loads the logger, then throws at load time like a test file with a broken require would.
require('../../../src/utils/logger');

throw new Error('fixture: thrown at load');
