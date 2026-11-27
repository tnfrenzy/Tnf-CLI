import fs from 'node:fs';

export type RoleGroups = { coding: string[]; library: string[]; cad3d: string[] };

function readKeys(file: string | null): string[] {
  if (!file) return [];
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const data: unknown = JSON.parse(text);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return [];
    return Object.keys(data as Record<string, unknown>);
  } catch {
    return [];
  }
}

export function loadRoleGroups(opts: {
  codingAgentsFile: string | null;
  design3dAgentsFile: string | null;
  libraryRoleIds: string[];
}): RoleGroups {
  return {
    coding: readKeys(opts.codingAgentsFile),
    library: Array.from(new Set(opts.libraryRoleIds)),
    cad3d: readKeys(opts.design3dAgentsFile),
  };
}
