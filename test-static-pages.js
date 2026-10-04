const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, 'public');

test('all frontend scripts parse without JavaScript syntax errors', () => {
  for (const filename of fs.readdirSync(path.join(root, 'assets')).filter(name => name.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(root, 'assets', filename), 'utf8');
    assert.doesNotThrow(() => new vm.Script(code, { filename }), filename);
  }
});

test('page scripts, stylesheets and local navigation targets exist', () => {
  for (const filename of fs.readdirSync(root).filter(name => name.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(root, filename), 'utf8');
    for (const match of html.matchAll(/(?:src|href)="(\/[^"?#]*)[^\"]*"/g)) {
      const target = match[1] === '/' ? '/index.html' : match[1];
      assert.ok(fs.existsSync(path.join(root, target)), `${filename}: missing ${target}`);
    }
  }
});

test('page-specific scripts reference existing static element IDs', () => {
  for (const filename of fs.readdirSync(root).filter(name => name.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(root, filename), 'utf8');
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
    for (const match of html.matchAll(/<script src="\/assets\/([^\"]+)"/g)) {
      if (match[1] === 'app.js') continue; // This file creates its own shared shell IDs.
      const script = fs.readFileSync(path.join(root, 'assets', match[1]), 'utf8');
      for (const reference of script.matchAll(/getElementById\(['"]([^'"\n]+)['"]\)/g)) {
        if (['draft-confirm', 'cull-cow'].includes(reference[1])) continue; // Generated controls.
        assert.ok(ids.has(reference[1]), `${filename}: missing #${reference[1]}`);
      }
    }
  }
});
