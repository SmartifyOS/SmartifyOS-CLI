import { join } from 'node:path';

/**
 * Switching Flutter GPU on in a car's app, which SmartifyOS draws the 3D car with.
 *
 * Flutter GPU is off unless the app switches it on in its own platform files, which a car's
 * owner never opens, so the CLI writes it there: whenever it adds a platform, changes what the
 * car runs, runs the app or builds it. Without it SmartifyOS logs that 3D needs Flutter GPU and
 * draws the car the next way it has, so nothing breaks, the car is just not 3D.
 *
 * Each file is edited line by line, only when it is there and only once, so anything else in
 * it stays as it was.
 */

/** What switching Flutter GPU on did. */
export interface FlutterGpuSync {
	/** The files that were changed, relative to the app. */
	changed: string[];
	/** What could not be written, for the owner to do by hand. */
	manual: string[];
}

/** Internal: one platform's file, and how it is switched on there. */
interface Switch {
	path: string;
	/** The text with Flutter GPU switched on, or undefined when there is no place for it. */
	edit(text: string): string | undefined;
	/** What to write by hand when there is no place for it. */
	manual: string;
}

export const linuxRunnerFile = 'linux/runner/my_application.cc';
export const macosInfoFile = 'macos/Runner/Info.plist';
export const windowsRunnerFile = 'windows/runner/main.cpp';

const comment = 'SmartifyOS draws the 3D car with Flutter GPU, which is off unless the app';
const commentEnd = 'switches it on.';

/** Internal: a line added after the first line matching `anchor`, with its indent. */
function afterLine(text: string, anchor: RegExp, lines: string[]): string | undefined {
	const match = anchor.exec(text);
	if (!match) return undefined;
	const lineStart = text.lastIndexOf('\n', match.index) + 1;
	const indent = /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
	const lineEnd = text.indexOf('\n', match.index + match[0].length);
	const at = lineEnd === -1 ? text.length : lineEnd + 1;
	const added = lines.map((line) => `${indent}${line}\n`).join('');
	return `${text.slice(0, at)}${lineEnd === -1 ? '\n' : ''}${added}${text.slice(at)}`;
}

/** Internal: lines added before the last match of `anchor`, one step further in than it. */
function beforeLast(
	text: string,
	anchor: RegExp,
	step: string,
	lines: string[],
): string | undefined {
	const matches = [...text.matchAll(anchor)];
	const match = matches.at(-1);
	if (match?.index === undefined) return undefined;
	const lineStart = text.lastIndexOf('\n', match.index) + 1;
	const before = text.slice(lineStart, match.index);
	if (before.trim() !== '') return undefined;
	const added = lines.map((line) => `${before}${step}${line}\n`).join('');
	return `${text.slice(0, lineStart)}${added}${text.slice(lineStart)}`;
}

/** A Linux runner (`my_application.cc`) that switches Flutter GPU on. */
export function linuxWithFlutterGpu(text: string): string | undefined {
	if (text.includes('fl_dart_project_set_enable_flutter_gpu')) return text;
	return afterLine(text, /g_autoptr\(FlDartProject\)\s+project\s*=\s*fl_dart_project_new\(\);/, [
		`// ${comment}`,
		`// ${commentEnd}`,
		'fl_dart_project_set_enable_flutter_gpu(project, TRUE);',
	]);
}

/** What to write into an Android manifest by hand when it has no `</application>`. */
export const androidFlutterGpuByHand =
	'add <meta-data android:name="io.flutter.embedding.android.EnableFlutterGPU" android:value="true" /> inside <application>.';

/** An Android manifest whose `<application>` switches Flutter GPU on. */
export function androidWithFlutterGpu(text: string): string | undefined {
	if (text.includes('io.flutter.embedding.android.EnableFlutterGPU')) return text;
	return beforeLast(text, /<\/application>/g, '    ', [
		`<!-- ${comment}`,
		`     ${commentEnd} -->`,
		'<meta-data',
		'    android:name="io.flutter.embedding.android.EnableFlutterGPU"',
		'    android:value="true" />',
	]);
}

/** A macOS `Info.plist` that switches Flutter GPU on. */
export function macosWithFlutterGpu(text: string): string | undefined {
	if (text.includes('FLTEnableFlutterGPU')) return text;
	// The last </dict> closes the top one, which is where the app's own keys are.
	return beforeLast(text, /<\/dict>/g, '\t', ['<key>FLTEnableFlutterGPU</key>', '<true/>']);
}

/** A Windows runner (`main.cpp`) that switches Flutter GPU on. */
export function windowsWithFlutterGpu(text: string): string | undefined {
	if (text.includes('set_enable_flutter_gpu')) return text;
	return afterLine(text, /flutter::DartProject\s+project\(L"data"\);/, [
		`// ${comment}`,
		`// ${commentEnd}`,
		'project.set_enable_flutter_gpu(true);',
	]);
}

const switches: Switch[] = [
	{
		path: linuxRunnerFile,
		edit: linuxWithFlutterGpu,
		manual: 'call fl_dart_project_set_enable_flutter_gpu(project, TRUE); on the FlDartProject.',
	},
	{
		path: 'android/app/src/main/AndroidManifest.xml',
		edit: androidWithFlutterGpu,
		manual: androidFlutterGpuByHand,
	},
	{
		path: macosInfoFile,
		edit: macosWithFlutterGpu,
		manual: 'add <key>FLTEnableFlutterGPU</key><true/> to the top <dict>.',
	},
	{
		path: windowsRunnerFile,
		edit: windowsWithFlutterGpu,
		manual: 'call project.set_enable_flutter_gpu(true); on the flutter::DartProject.',
	},
];

/**
 * Switches Flutter GPU on in every platform the app has (Linux, Android, macOS, Windows).
 * A platform the app has no folder for is left out, and one already switched on is left alone.
 */
export async function switchOnFlutterGpu(appDir: string): Promise<FlutterGpuSync> {
	const changed: string[] = [];
	const manual: string[] = [];
	for (const platform of switches) {
		const file = Bun.file(join(appDir, platform.path));
		if (!(await file.exists())) continue;
		const text = await file.text();
		const next = platform.edit(text);
		if (next === undefined) {
			manual.push(`${platform.path}: ${platform.manual}`);
		} else if (next !== text) {
			await Bun.write(join(appDir, platform.path), next);
			changed.push(platform.path);
		}
	}
	return { changed, manual };
}
