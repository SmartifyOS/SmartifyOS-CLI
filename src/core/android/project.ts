import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { androidFlutterGpuByHand, androidWithFlutterGpu } from '../flutter-gpu.ts';
import { type AndroidNeeds, collectAndroidNeeds, requesterNames } from './needs.ts';

/**
 * Keeping a car's Android project (its `android/` folder, which `flutter create` makes) the way
 * SmartifyOS needs it. A driver never opens that folder, so the CLI writes what is needed there
 * every time it changes what the car runs, and before every Android build:
 *
 * - Both launch themes use the whole screen, the strip beside a camera cutout included.
 *   SmartifyOS hides Android's bars itself, but without this Android keeps that strip black.
 * - The permissions every package lists under `smartify_os: android: permissions:`, in a block
 *   of the manifest that is the CLI's, so one no package asks for any more goes again.
 * - The `minSdk` the packages ask for, as `maxOf(flutter.minSdkVersion, N)`, so Flutter's own
 *   is kept when it is higher. One the owner wrote that is high enough stays.
 * - The app's `MainActivity` can be the tablet's home screen, so a car's tablet starts into
 *   SmartifyOS and its home button goes back to it. Android asks once which home screen to
 *   use, or `smartify-os tablet` sets it (src/core/android/tablet.ts). It also matters for
 *   updates: once SmartifyOS updated itself from a stick, Android only starts a home screen
 *   again by itself. A phone that only tries the app is asked too, and keeps its own.
 * - Flutter GPU switched on in the manifest, which the 3D car is drawn with (see
 *   `src/core/flutter-gpu.ts`, which does the same for the other platforms). Core's own
 *   manifest switches it on as well now, so this only matters for an older SmartifyOS.
 *
 * Every file is edited line by line, so anything else in it stays as it was.
 */

/** What syncing the Android project did. */
export interface AndroidSync {
	/** Whether the car's app has an Android part at all. Nothing is done without one. */
	android: boolean;
	/** The files that were changed, relative to the app. */
	changed: string[];
	/** What could not be written, for the owner to do by hand. */
	manual: string[];
	needs: AndroidNeeds | null;
}

/** The theme files Flutter makes, relative to the app. */
export const styleFiles = [
	'android/app/src/main/res/values/styles.xml',
	'android/app/src/main/res/values-night/styles.xml',
];

export const manifestFile = 'android/app/src/main/AndroidManifest.xml';

/** Flutter writes Kotlin since 3.29, Groovy before. */
export const gradleFiles = ['android/app/build.gradle.kts', 'android/app/build.gradle'];

/** The themes SmartifyOS runs in, the one shown while it starts and the one after. */
const themes = ['LaunchTheme', 'NormalTheme'];

const cutoutItem = '<item name="android:windowLayoutInDisplayCutoutMode">shortEdges</item>';

/** Brings the car's Android project in line with what its packages need. Pub has to have run. */
export async function syncAndroid(appDir: string): Promise<AndroidSync> {
	if (!existsSync(join(appDir, 'android'))) {
		return { android: false, changed: [], manual: [], needs: null };
	}
	const needs = await collectAndroidNeeds(appDir);
	const changed: string[] = [];
	const manual: string[] = [];

	const edit = async (path: string, change: (text: string) => string | undefined) => {
		const file = Bun.file(join(appDir, path));
		if (!(await file.exists())) return;
		const text = await file.text();
		const next = change(text);
		if (next !== undefined && next !== text) {
			await Bun.write(join(appDir, path), next);
			changed.push(path);
		}
	};

	for (const path of styleFiles) await edit(path, withFullScreenThemes);
	await edit(manifestFile, (text) => {
		const withNeeds = withPermissions(text, needs);
		const withHome = withHomeScreen(withNeeds);
		if (withHome === undefined) manual.push(`${manifestFile}: ${homeScreenByHand}`);
		const withGpu = androidWithFlutterGpu(withHome ?? withNeeds);
		if (withGpu === undefined) {
			manual.push(`${manifestFile}: ${androidFlutterGpuByHand}`);
		}
		return withGpu ?? withHome ?? withNeeds;
	});
	for (const path of gradleFiles) {
		await edit(path, (text) => {
			const result = withMinSdk(text, needs, path.endsWith('.kts') ? 'kotlin' : 'groovy');
			if (result.manual) manual.push(`${path}: ${result.manual}`);
			return result.text;
		});
	}
	return { android: true, changed, manual, needs };
}

/** A styles.xml where both of SmartifyOS's themes use the whole screen. */
export function withFullScreenThemes(text: string): string {
	let out = text;
	for (const theme of themes) {
		const open = new RegExp(`^([ \\t]*)<style\\s+name="${theme}"[^>]*>[^\\n]*\\n`, 'm').exec(out);
		if (!open) continue;
		const start = open.index + open[0].length;
		const end = out.indexOf('</style>', start);
		if (end === -1 || out.slice(start, end).includes('windowLayoutInDisplayCutoutMode')) continue;
		const indent = `${open[1]}    `;
		const lines = [
			`${indent}<!-- SmartifyOS hides Android's own bars and uses the whole screen,`,
			`${indent}     the strip beside a camera cutout included. -->`,
			`${indent}${cutoutItem}`,
		];
		out = `${out.slice(0, start)}${lines.join('\n')}\n${out.slice(start)}`;
	}
	return out;
}

/** What to write into the manifest by hand when its launcher intent filter is not found. */
export const homeScreenByHand =
	"add an <intent-filter> with the action android.intent.action.MAIN and the categories android.intent.category.HOME and android.intent.category.DEFAULT to MainActivity, so it can be the tablet's home screen.";

/**
 * A manifest whose `MainActivity` can be the tablet's home screen: an intent filter with the
 * HOME category, right after the launcher one. One there already is left alone, and
 * `undefined` means there is no launcher intent filter to put it next to.
 */
export function withHomeScreen(text: string): string | undefined {
	const activity = /<activity\b[^>]*android:name="[^"]*\.?MainActivity"[\s\S]*?<\/activity>/.exec(
		text,
	);
	const scope = activity ? activity[0] : text;
	if (scope.includes('android.intent.category.HOME')) return text;
	const offset = activity?.index ?? 0;
	const launcher = /android\.intent\.category\.LAUNCHER/.exec(scope);
	if (!launcher) return undefined;
	const close = scope.indexOf('</intent-filter>', launcher.index);
	if (close === -1) return undefined;
	const filterStart = scope.lastIndexOf('<intent-filter', launcher.index);
	if (filterStart === -1) return undefined;
	const lineStart = text.lastIndexOf('\n', offset + filterStart) + 1;
	const indent = /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
	const closeEnd = text.indexOf('\n', offset + close);
	const at = closeEnd === -1 ? text.length : closeEnd + 1;
	const lines = [
		"<!-- smartify-os: lets SmartifyOS be the tablet's home screen, which it starts into",
		'     and the home button goes back to. Written by smartify-os. -->',
		'<intent-filter>',
		'    <action android:name="android.intent.action.MAIN" />',
		'    <category android:name="android.intent.category.HOME" />',
		'    <category android:name="android.intent.category.DEFAULT" />',
		'</intent-filter>',
	];
	const added = lines.map((line) => `${indent}${line}\n`).join('');
	return `${text.slice(0, at)}${closeEnd === -1 ? '\n' : ''}${added}${text.slice(at)}`;
}

/** The first line of the manifest's block that is the CLI's, and its last. */
const blockStart = '<!-- smartify-os: what SmartifyOS and your extensions need.';
const blockEnd = '<!-- smartify-os: end -->';

/** A manifest with the CLI's block of permissions as the packages need them now. */
export function withPermissions(text: string, needs: Pick<AndroidNeeds, 'permissions'>): string {
	let out = text;
	const start = out.indexOf(blockStart);
	const end = out.indexOf(blockEnd);
	if (start !== -1 && end > start) {
		const lineStart = out.lastIndexOf('\n', start) + 1;
		const lineEnd = out.indexOf('\n', end);
		out = out.slice(0, lineStart) + out.slice(lineEnd === -1 ? out.length : lineEnd + 1);
	}

	// One the owner declared themselves is theirs.
	const declared = new Set(
		[...out.matchAll(/<uses-permission\b[^>]*android:name="([^"]+)"/g)].map((m) => m[1]),
	);
	const wanted = needs.permissions.filter((need) => !declared.has(need.name));
	if (wanted.length === 0) return out;

	const manifest = /<manifest\b[^>]*>[^\n]*\n/.exec(out);
	if (!manifest) return out;
	const at = manifest.index + manifest[0].length;
	const block = [
		`    ${blockStart} Written by smartify-os`,
		'         whenever it changes what your car runs, so put your own outside these lines. -->',
		...wanted.map(
			(need) =>
				`    <uses-permission android:name="${need.name}" /> <!-- ${requesterNames(need.requesters)} -->`,
		),
		`    ${blockEnd}`,
	];
	return `${out.slice(0, at)}${block.join('\n')}\n${out.slice(at)}`;
}

/** Internal: what the CLI writes for a `minSdk`, and how it recognises its own. */
const minSdkCall = {
	kotlin: (level: number) => `maxOf(flutter.minSdkVersion, ${level})`,
	groovy: (level: number) => `Math.max(flutter.minSdkVersion, ${level})`,
};
const ownMinSdk = /^(?:maxOf|Math\.max)\(\s*flutter\.minSdkVersion\s*,\s*\d+\s*\)$/;
const ownComment = '// Written by smartify-os:';

/**
 * A build.gradle(.kts) whose `minSdk` is at least what the packages need: Flutter's own and the
 * CLI's are replaced, a number of the owner's only when it is too low, and anything else is
 * left for the owner, with what it has to be.
 */
export function withMinSdk(
	text: string,
	needs: Pick<AndroidNeeds, 'minSdk'>,
	language: 'kotlin' | 'groovy',
): { text: string; manual?: string } {
	const line = /^([ \t]*)(minSdk(?:Version)?)(\s*=\s*|[ \t]+)(.+?)[ \t]*$/m.exec(text);
	if (!line) {
		return needs.minSdk
			? {
					text,
					manual: `set minSdk to at least ${needs.minSdk.level}, which ${requesterNames(needs.minSdk.requesters)} needs.`,
				}
			: { text };
	}
	const [whole, indent, key, between, written] = line as unknown as [
		string,
		string,
		string,
		string,
		string,
	];

	// What is written, without a comment of the CLI's after it.
	const ours = written.includes(ownComment);
	const value = written.split('//')[0]?.trim() ?? '';
	const isFlutters = value === 'flutter.minSdkVersion';
	const isOurs = ownMinSdk.test(value);
	const number = /^\d+$/.test(value) ? Number(value) : undefined;

	let next: string | undefined;
	if (!needs.minSdk) {
		if (isOurs || ours) next = 'flutter.minSdkVersion';
	} else if (
		isFlutters ||
		isOurs ||
		ours ||
		(number !== undefined && number < needs.minSdk.level)
	) {
		next = `${minSdkCall[language](needs.minSdk.level)} ${ownComment} what ${requesterNames(needs.minSdk.requesters)} needs.`;
	} else if (number === undefined) {
		return {
			text,
			manual: `minSdk is written as code, so check it is at least ${needs.minSdk.level}, which ${requesterNames(needs.minSdk.requesters)} needs.`,
		};
	}
	if (next === undefined) return { text };
	const replaced = `${indent}${key}${between}${next}`;
	return { text: text.replace(whole, replaced) };
}
