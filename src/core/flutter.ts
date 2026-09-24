import { join } from 'node:path';
import { type ProcessResult, run } from './process.ts';

/**
 * The few Flutter and Dart commands the CLI runs for the user, and reading what they say.
 */

/** One thing the analyzer found. */
export interface Problem {
	severity: 'error' | 'warning' | 'info';
	/** `undefined_method`. */
	code: string;
	/** Absolute path of the file it is in. */
	file: string;
	line: number;
	message: string;
}

/** `flutter pub get`, which fetches whatever pubspec.yaml now asks for. */
export async function pubGet(dir: string): Promise<ProcessResult> {
	return await run('flutter', ['pub', 'get'], { cwd: dir });
}

/** `flutter pub upgrade`, which moves the named packages on to their newest allowed version. */
export async function pubUpgrade(dir: string, packages: string[]): Promise<ProcessResult> {
	return await run('flutter', ['pub', 'upgrade', ...packages], { cwd: dir });
}

/**
 * Internal: splits one line of the analyzer's machine format on the `|` that are not
 * escaped, and unescapes the rest.
 */
function splitMachineLine(line: string): string[] {
	const fields: string[] = [];
	let current = '';
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '\\' && i + 1 < line.length) {
			current += line[i + 1];
			i++;
		} else if (char === '|') {
			fields.push(current);
			current = '';
		} else {
			current += char;
		}
	}
	fields.push(current);
	return fields;
}

/**
 * Reads `dart analyze --format=machine` output.
 *
 * Each line is `SEVERITY|TYPE|CODE|FILE|LINE|COLUMN|LENGTH|MESSAGE`. Anything else, like a
 * progress line, is skipped.
 */
export function parseAnalyzerOutput(output: string): Problem[] {
	const problems: Problem[] = [];
	for (const line of output.split(/\r?\n/)) {
		const fields = splitMachineLine(line.trim());
		if (fields.length < 8) continue;
		const [severity, , code, file, lineNumber, , , ...message] = fields;
		const level = severity?.toLowerCase();
		if (level !== 'error' && level !== 'warning' && level !== 'info') continue;
		problems.push({
			severity: level,
			code: (code ?? '').toLowerCase(),
			file: file ?? '',
			line: Number(lineNumber) || 0,
			message: message.join('|').trim(),
		});
	}
	return problems;
}

/**
 * Analyzes folders the way the car's app sees them, and gives back only the errors.
 *
 * `packages` is the app's own `package_config.json`. Handing it over is what lets an
 * extension's `lib` in the pub cache be checked against the SmartifyOS this app resolved,
 * which is exactly the question "does this extension still build here". Analyzing the app
 * on its own would not ask it: the analyzer only reports on the folders it is given.
 */
export async function analyzeErrors(folders: string[], packages: string): Promise<Problem[]> {
	const result = await run('dart', [
		'analyze',
		'--format=machine',
		'--no-fatal-warnings',
		`--packages=${packages}`,
		...folders,
	]);
	// Diagnostics go to stderr in the machine format, but read both in case that changes.
	return parseAnalyzerOutput(`${result.stdout}\n${result.stderr}`).filter(
		(problem) => problem.severity === 'error',
	);
}

/** Where pub writes which folder every package of an app is in. */
export function packageConfigPath(appDir: string): string {
	return join(appDir, '.dart_tool', 'package_config.json');
}
