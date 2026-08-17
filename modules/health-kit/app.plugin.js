// Expo resolves config plugins by module name, looking for `app.plugin.js` at
// the package root. This re-export keeps the implementation in plugin/ while
// letting app.json reference the package as "@running/health-kit".
module.exports = require('./plugin/withHealthKit.js');
