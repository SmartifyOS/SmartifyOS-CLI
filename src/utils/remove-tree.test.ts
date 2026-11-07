import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTree } from './remove-tree.ts';

const dir = await mkdtemp(join(tmpdir(), 'smartify-os-remove-tree-'));

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('removeTree', () => {
	test('deletes a folder and everything in it', async () => {
		const folder = join(dir, 'tree');
		await Bun.write(join(folder, 'a.txt'), 'a');
		await Bun.write(join(folder, '._a.txt'), 'mac');
		await Bun.write(join(folder, 'sub', 'deeper', 'b.txt'), 'b');
		await removeTree(folder);
		expect(existsSync(folder)).toBe(false);
	});

	test('deletes a single file, and is fine with nothing there', async () => {
		const file = join(dir, 'single.txt');
		await Bun.write(file, 'x');
		await removeTree(file);
		expect(existsSync(file)).toBe(false);
		await removeTree(join(dir, 'never-there'));
	});
});
