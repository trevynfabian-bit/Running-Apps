/**
 * Metro configuration for a pnpm monorepo.
 *
 * Two things need handling that the default config does not do:
 *
 * 1. Workspace packages. `@running/core` and friends are consumed as
 *    TypeScript source, so Metro must watch the repo root and resolve modules
 *    from the root `node_modules` as well as the app's own.
 *
 * 2. Extension rewriting. The shared packages use explicit `.js` specifiers
 *    (`import './domain/athlete.js'`), which is what TypeScript's NodeNext
 *    resolution and any future Node-ESM build require. Metro resolves against
 *    the on-disk files, where those are `.ts`, so a specifier ending in `.js`
 *    has to be retried against the TypeScript extensions. Rewriting here keeps
 *    the shared packages spec-correct rather than bending them to the bundler.
 */

const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');
const fs = require('node:fs');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Watch the whole workspace so edits to packages/* trigger a reload.
config.watchFolders = [workspaceRoot];

// 2. Resolve from both the app and the hoisted root store.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// pnpm's symlinked layout means a package can legitimately resolve outside the
// project root; don't restrict Metro to a single node_modules tree.
config.resolver.disableHierarchicalLookup = false;

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Only relative specifiers ending in .js are candidates for rewriting;
  // package specifiers are left to the normal resolver.
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    const base = moduleName.slice(0, -'.js'.length);
    const originDir = path.dirname(context.originModulePath);

    for (const extension of TS_EXTENSIONS) {
      const candidate = path.resolve(originDir, `${base}${extension}`);
      if (fs.existsSync(candidate)) {
        return { type: 'sourceFile', filePath: candidate };
      }
    }
  }

  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
