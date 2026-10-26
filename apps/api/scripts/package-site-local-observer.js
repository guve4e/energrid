const fs = require('node:fs')
const path = require('node:path')

const outputDirectory = path.resolve(__dirname, '../../../dist/site-local-discovery-runner')
const bundlePath = path.join(outputDirectory, 'runner.js')
if (!fs.existsSync(bundlePath)) throw new Error('Build the observer runner before packaging it.')

const packageManifest = {
  name: 'energrid-site-local-discovery-runner',
  version: '1.0.0',
  private: true,
  type: 'commonjs',
  main: 'runner.js',
  engines: { node: '>=22 <23' },
  dependencies: {},
}

fs.writeFileSync(path.join(outputDirectory, 'package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`)
fs.writeFileSync(path.join(outputDirectory, 'README.txt'), [
  'Energrid site-local one-shot discovery observer',
  '',
  'Requires Linux, Node.js 22, and an installed unprivileged Nmap executable.',
  'No Nest application, database, API, MQTT subscriber, or environment file is required.',
  '',
  'Run only after the operator has separately authorized this exact network scope:',
  '  node runner.js --scope-cidr <authorized-IPv4-CIDR> --confirm-authorized',
  '',
  'The command writes one JSON result to stdout. Redirect it to a new file in the',
  'temporary execution directory if it must be preserved. It does not persist or',
  'ingest Discovery Memory, create candidates, or enroll devices.',
  'Exit codes: 0 complete, 2 rejected input, 3 failed or incomplete collection.',
  '',
].join('\n'))
