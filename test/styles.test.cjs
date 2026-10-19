const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = require('../plugin.json');
const host = process.env.FEEDBACK_HOST_DIR || path.resolve(root, '../feedBack');
const hostAvailable = fs.existsSync(path.join(host, 'static/js/plugin-loader.js'));

test('stylesheet ships at the supported sandboxed manifest path', () => {
  assert.equal(manifest.styles, 'assets/game.css');
  assert.equal(manifest.version, '0.2.1');
  assert.equal(manifest.version, require('../package.json').version);
  assert.ok(fs.statSync(path.join(root, manifest.styles)).isFile());
  assert.equal(fs.existsSync(path.join(root, 'game.css')), false);
});

// Execute the host's implementation, not a second implementation of its rules.
function hostStyleSource() {
  const source = fs.readFileSync(path.join(host, 'static/js/plugin-loader.js'), 'utf8');
  const start = source.indexOf('let loadedStyles =');
  const end = source.indexOf('const _reconcilePluginStyles =', start);
  assert.ok(start >= 0 && end > start, 'Host stylesheet seam changed; update the harness');
  return `${source.slice(start, end)}\nglobalThis.inject = _injectPluginStyles;`;
}

test('actual host loader injects, deduplicates and upgrades the stylesheet; old path is rejected', { skip: !hostAvailable }, () => {
  const links = [], warnings = [];
  const core = { href: '/static/tailwind.min.css' };
  const document = {
    querySelectorAll: () => links.slice(),
    createElement: () => {
      const link = { dataset: {}, remove() { links.splice(links.indexOf(link), 1); } };
      return link;
    },
    head: {
      querySelector: () => core,
      insertBefore(link, before) { assert.equal(before, core); links.push(link); },
      appendChild() { assert.fail('Must insert before core CSS'); },
    },
  };
  const context = vm.createContext({ document, window: { feedBack: {} }, console: { warn: message => warnings.push(message) } });
  vm.runInContext(hostStyleSource(), context);
  const plugin = { ...manifest, has_styles: true };
  context.inject({ ...plugin, version: '0.2.0', styles: 'game.css' });
  assert.equal(links.length, 0);
  assert.equal(warnings.length, 1);
  context.inject(plugin);
  assert.equal(links.length, 1);
  assert.equal(links[0].rel, 'stylesheet');
  assert.equal(links[0].href, '/api/plugins/fretboard_recall/assets/game.css?v=0.2.1');
  assert.equal(links[0].dataset.pluginVersion, '0.2.1');
  context.inject(plugin);
  assert.equal(links.length, 1);
  context.inject({ ...plugin, version: '0.2.2' });
  assert.equal(links.length, 1);
  assert.match(links[0].href, /\?v=0\.2\.2$/);
  context.inject({ ...plugin, has_styles: false });
  assert.equal(links.length, 0);
});

test('actual host manifest derivation and asset route resolve CSS and reject traversal', { skip: !hostAvailable }, () => {
  const result = JSON.parse(execFileSync(process.env.PYTHON || 'python3', [path.join(__dirname, 'host-styles.py'), host, root], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }));
  assert.equal(result.has_styles, true);
  assert.equal(result.styles, manifest.styles);
  assert.equal(result.status, 200);
  assert.equal(result.media_type, 'text/css');
  assert.equal(result.body, fs.readFileSync(path.join(root, manifest.styles), 'utf8'));
  assert.equal(result.traversal_status, 404);
  assert.equal(result.missing_status, 404);
  assert.equal(result.pending_status, 404);
});
