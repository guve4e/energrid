const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin')
const { join } = require('path')

module.exports = {
  target: 'node',
  output: {
    path: join(__dirname, '../../dist/site-local-discovery-runner'),
    filename: 'runner.js',
    clean: true,
  },
  resolve: {
    alias: {
      '@nestjs/common$': join(__dirname, 'src/app/modules/devices/site-local-observer-nest-shim.ts'),
    },
  },
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      main: './src/app/modules/devices/site-local-discovery-cli.ts',
      tsConfig: './tsconfig.app.json',
      assets: [],
      optimization: true,
      outputHashing: 'none',
      sourceMap: false,
      generatePackageJson: false,
      externalDependencies: 'none',
    }),
  ],
}
