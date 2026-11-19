// Synthetic early launch failure: exercise the real launcher's stderr/error boundary.
const { app } = require('electron');
process.stderr.write(JSON.stringify({ initialization: { api_key: process.env.ECOMGEN_PRIVACY_TEST_KEY,
  snapshot: process.env.ECOMGEN_PRIVACY_TEST_SNAPSHOT, responseBody: process.env.ECOMGEN_PRIVACY_TEST_SNAPSHOT } }) + '\n');
app.whenReady().then(() => app.exit(7));
