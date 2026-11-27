import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRoleGroups } from '../../src/core/usage/role-groups.js';

const root = path.resolve(__dirname, '..', '..');
const codingReal = path.join(root, 'config', 'roles-coding.json');
const design3dReal = path.join(root, 'config', 'roles-design3d.json');

function withTmp(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-groups-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('loadRoleGroups', () => {
  it('reads keys from the real config files without mixing coding and cad3d', () => {
    const r = loadRoleGroups({ codingAgentsFile: codingReal, design3dAgentsFile: design3dReal, libraryRoleIds: [] });
    const codingKeys = Object.keys(JSON.parse(fs.readFileSync(codingReal, 'utf8').replace(/^﻿/, '')));
    const cadKeys = Object.keys(JSON.parse(fs.readFileSync(design3dReal, 'utf8').replace(/^﻿/, '')));
    expect(r.coding).toEqual(codingKeys);
    expect(r.cad3d).toEqual(cadKeys);
    expect(r.coding.length).toBeGreaterThan(0);
    expect(r.cad3d.length).toBeGreaterThan(0);
    expect(r.coding).not.toEqual(r.cad3d);
    expect(r.library).toEqual([]);
  });

  it('returns empty for missing file, null path, corrupt and non-object JSON', () => {
    withTmp((dir) => {
      const bad = path.join(dir, 'bad.json');
      fs.writeFileSync(bad, '{not json');
      const arr = path.join(dir, 'arr.json');
      fs.writeFileSync(arr, '["a"]');
      const nul = path.join(dir, 'null.json');
      fs.writeFileSync(nul, 'null');
      const num = path.join(dir, 'num.json');
      fs.writeFileSync(num, '42');
      const missing = path.join(dir, 'missing.json');
      const cases: Array<string | null> = [missing, bad, arr, nul, num, null];
      for (const c of cases) {
        expect(() => loadRoleGroups({ codingAgentsFile: c, design3dAgentsFile: c, libraryRoleIds: [] })).not.toThrow();
        const r = loadRoleGroups({ codingAgentsFile: c, design3dAgentsFile: c, libraryRoleIds: [] });
        expect(r.coding).toEqual([]);
        expect(r.cad3d).toEqual([]);
      }
    });
  });

  it('reads keys from a file with a BOM', () => {
    withTmp((dir) => {
      const f = path.join(dir, 'bom.json');
      fs.writeFileSync(f, '﻿{"x":{},"y":{}}');
      const r = loadRoleGroups({ codingAgentsFile: f, design3dAgentsFile: null, libraryRoleIds: [] });
      expect(r.coding).toEqual(['x', 'y']);
      expect(r.cad3d).toEqual([]);
    });
  });

  it('dedupes library ids keeping first occurrence order', () => {
    const r = loadRoleGroups({ codingAgentsFile: null, design3dAgentsFile: null, libraryRoleIds: ['a', 'b', 'a'] });
    expect(r.library).toEqual(['a', 'b']);
  });
});
