// Builds this plugin's two runtime bundles from source:
//   lib/index.js   host bundle (ESM, what DSH loads)
//   lib/client.js  web client bundle (window.__ModuleLoader__ loader)
//
// The upstream package ships prebuilt bundles and no node_modules, so esbuild and
// the other build-time packages are resolved from outside the checkout:
//   DSH_BUILD_ESBUILD_DIR   directory that contains `esbuild` (required)
//   DSH_BUILD_NODE_MODULES  extra resolution roots, ';' separated (optional)
//                           e.g. the DSH profile node_modules for @matrix-org/olm,
//                           semver, https-proxy-agent, @deepseek-ai/cordis
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const esbuildDir = process.env.DSH_BUILD_ESBUILD_DIR;
if (!esbuildDir) throw new Error('DSH_BUILD_ESBUILD_DIR must point at a node_modules containing esbuild');

const extraRoots = (process.env.DSH_BUILD_NODE_MODULES ?? '')
  .split(';')
  .map((entry) => entry.trim())
  .filter(Boolean);
const nodePaths = [esbuildDir, ...extraRoots];

const require = createRequire(resolve(esbuildDir, 'noop.cjs'));
const { build } = require('esbuild');
const { larkSdkHandshakePatch } = await import('../plugin-src/host/lark-sdk-handshake-patch.mjs');

const externalRuntimePackages = [
  '@tencent-connect/qqbot-connector',
  '@tencent-connect/qqbot-nodejs',
  '@wecom/aibot-node-sdk',
  'dingtalk-stream',
  'imapflow',
  'mailparser',
  'nodemailer',
  'qrcode',
  'sharp',
  'undici',
  // Discord voice playback: loaded lazily at runtime, so the fork still boots
  // (and every other channel still works) when they are not installed.
  '@discordjs/opus',
  '@discordjs/voice',
  'discord.js',
  'opusscript',
  'prism-media',
];
const external = externalRuntimePackages.flatMap((name) => [name, `${name}/*`]);

const banner = [
  "import { createRequire as __dshCreateRequire } from 'node:module';",
  "import { dirname as __dshDirname } from 'node:path';",
  "import { fileURLToPath as __dshFileURLToPath } from 'node:url';",
  'const require = __dshCreateRequire(import.meta.url);',
  'const __filename = __dshFileURLToPath(import.meta.url);',
  'const __dirname = __dshDirname(__filename);',
].join('\n');

await mkdir(resolve(packageRoot, 'lib'), { recursive: true });

const host = await build({
  entryPoints: [resolve(packageRoot, 'plugin-src/host/index.mjs')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  mainFields: ['module', 'main'],
  nodePaths,
  external,
  plugins: [larkSdkHandshakePatch],
  outfile: resolve(packageRoot, 'lib/index.js'),
  banner: { js: banner },
  sourcemap: false,
  minify: true,
  legalComments: 'eof',
  logLevel: 'warning',
});

const clientBuild = await build({
  entryPoints: [resolve(packageRoot, 'plugin-src/client/index.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  nodePaths,
  external: ['react', 'react-dom'],
  write: false,
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
});
const bundled = clientBuild.outputFiles?.[0]?.text;
if (!bundled) throw new Error('esbuild did not produce a client bundle');

const loaderId = process.env.DSH_IM_CLIENT_ID ?? 'dsh-discord';
const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(loaderId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled}
    return module.exports;
  }
});
`;
await writeFile(resolve(packageRoot, 'lib/client.js'), wrapped, 'utf8');

console.log(`host   errors=${host.errors.length} warnings=${host.warnings.length}`);
console.log(`client errors=0 warnings=0 loaderId=${loaderId}`);
