import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConsumerSkills } from '../src/consumer-skills.js';

test('malformed and oversized consumer skills are logged and skipped without blocking startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openworkspace-skills-'));
  const messages: string[] = [];
  try {
    await mkdir(join(directory, 'valid'));
    await writeFile(join(directory, 'valid', 'SKILL.md'), '---\nname: valid\ndescription: Use this valid skill.\n---\nBody\n');
    await mkdir(join(directory, 'bad-frontmatter'));
    await writeFile(join(directory, 'bad-frontmatter', 'SKILL.md'), '---\nname: bad-frontmatter\n---\nNo description.\n');
    await mkdir(join(directory, 'too-large'));
    await writeFile(join(directory, 'too-large', 'SKILL.md'), `---\nname: too-large\ndescription: Oversized skill.\n---\n${'x'.repeat(9 * 1024)}`);

    const loaded = await loadConsumerSkills(directory, message => messages.push(message));
    assert.deepEqual(loaded.map(skill => skill.name), ['valid']);
    assert.equal(loaded[0].text, '---\nname: valid\ndescription: Use this valid skill.\n---\nBody\n');
    assert.equal(messages.length, 2);
    assert.ok(messages.some(message => message.includes('bad-frontmatter') && message.includes('invalid frontmatter')));
    assert.ok(messages.some(message => message.includes('too-large') && message.includes('size limit')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a symlinked skills root is skipped without serving external skills or failing startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openworkspace-skills-root-'));
  const messages: string[] = [];
  try {
    const externalSkills = join(directory, 'external-skills');
    await mkdir(join(externalSkills, 'external-skill'), { recursive: true });
    await writeFile(join(externalSkills, 'external-skill', 'SKILL.md'), '---\nname: external-skill\ndescription: External content.\n---\nMust not be served.\n');
    const skillsRoot = join(directory, 'skills');
    await symlink(externalSkills, skillsRoot, 'dir');

    const loaded = await loadConsumerSkills(skillsRoot, message => messages.push(message));
    assert.deepEqual(loaded, []);
    assert.ok(messages.some(message => message.includes('directory is a symbolic link')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
