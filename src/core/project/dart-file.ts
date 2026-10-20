import { run } from '../process.ts';

/**
 * Writing Dart into a car's app the way its owner would: every file the CLI writes or changes is
 * run through `dart format` afterwards, so what it added reads like the rest of the file.
 */

/** Formats files with `dart format`, quietly doing nothing when there is no Dart. */
export async function formatDart(paths: string[]): Promise<void> {
	if (paths.length === 0) return;
	try {
		await run('dart', ['format', ...paths]);
	} catch {
		// Unformatted still builds.
	}
}

/** Writes a Dart file that was `before`, and formats it. Nothing is written when nothing changed. */
export async function writeDart(path: string, before: string, after: string): Promise<void> {
	if (after === before) return;
	await Bun.write(path, after);
	await formatDart([path]);
}
