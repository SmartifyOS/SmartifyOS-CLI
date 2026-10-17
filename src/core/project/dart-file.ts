import { run } from '../process.ts';

/**
 * Writing Dart into a car's app the way its owner would: run through `dart format` afterwards,
 * but only a file that was formatted before, so an owner's own style is left alone.
 */

/** Whether `dart format` would leave a file as it is. False when there is no Dart to ask. */
export async function isFormatted(path: string): Promise<boolean> {
	try {
		const result = await run('dart', ['format', '--output=none', '--set-exit-if-changed', path]);
		return result.code === 0;
	} catch {
		return false;
	}
}

/** Formats files with `dart format`, quietly doing nothing when there is no Dart. */
export async function formatDart(paths: string[]): Promise<void> {
	if (paths.length === 0) return;
	try {
		await run('dart', ['format', ...paths]);
	} catch {
		// Unformatted still builds.
	}
}

/** Writes a Dart file that was `before`, formatted again afterwards when it was before. */
export async function writeDart(path: string, before: string, after: string): Promise<void> {
	if (after === before) return;
	const formatted = await isFormatted(path);
	await Bun.write(path, after);
	if (formatted) await formatDart([path]);
}
