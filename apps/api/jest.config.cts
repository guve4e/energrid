module.exports = {
  displayName: 'api',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  // These two suites use node:test and run separately with `node --test`.
  // Jest cannot collect node:test cases and would report them as empty suites.
  testPathIgnorePatterns: [
    '<rootDir>/scripts/personal-finance-transfer.test.js',
    '<rootDir>/scripts/personal-finance-transfer.integration.test.js',
  ],
  coverageDirectory: '../coverage/api',
};
