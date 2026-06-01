module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts", "**/*.test.ts"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
};
