/**
 * jest-environment-node, plus one thing the sandbox cannot do by itself: hand
 * an ESM-only package to Node's own require(). See esm-native-transform.cjs.
 */
const { TestEnvironment } = require('jest-environment-node');

class HookpostNodeEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    // Node's require, from outside the sandbox. Node 22 can require() ESM.
    this.global.__nativeRequire = require;
  }
}

module.exports = HookpostNodeEnvironment;
