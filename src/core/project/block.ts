import type { GitSource } from '../git.ts';
import { entryKeyLine, entryNames, removeEntry, setEntry, yamlScalar } from '../pubspec/blocks.ts';
import { corePackage, type NeededOverride } from '../smartify-os.ts';

/**
 * The part of a car's `pubspec.yaml` the CLI owns.
 *
 * Everything SmartifyOS is listed twice: under `dependencies` as `any`, so the app may import
 * it, and under `dependency_overrides` with where it actually comes from. Pub cannot put two
 * git refs of one package into one app, and an override is the one thing that beats every
 * version constraint, so the app is the only place that says where anything comes from.
 *
 * ```yaml
 * dependencies:
 *   smartify_os_core: any
 *   smartify_os_android_auto: any
 *
 * dependency_overrides:
 *   smartify_os_core:
 *     git:
 *       url: https://github.com/Mauznemo/smartify_os_flutter_test.git
 *       path: smartify_os_core
 *       ref: v0.3.0
 *   smartify_os_android_auto:
 *     git:
 *       url: https://github.com/Mauznemo/smartify_os_android_auto.git
 *       ref: v0.1.0
 *   flutter_angle: # SmartifyOS needs this too, smartify-os keeps it in step
 *     git:
 *       ...
 * ```
 *
 * Every other line of the file is left alone.
 */

/**
 * Written after the name of every override that is only there because SmartifyOS needs it,
 * which is how the next update knows which ones to replace.
 */
export const neededMarker = '# SmartifyOS needs this too, smartify-os keeps it in step';

/** The lines of a git dependency, at the left edge. */
export function gitEntry(name: string, source: GitSource): string[] {
	return [
		`${name}:`,
		'  git:',
		`    url: ${yamlScalar(source.url)}`,
		...(source.path ? [`    path: ${yamlScalar(source.path)}`] : []),
		`    ref: ${yamlScalar(source.ref)}`,
	];
}

/** The lines of a path dependency, at the left edge. */
export function pathEntry(name: string, path: string): string[] {
	return [`${name}:`, `  path: ${yamlScalar(path)}`];
}

/** Internal: `name: any` under dependencies, replacing whatever was written there. */
function asAny(text: string, name: string): string {
	return setEntry(text, 'dependencies', name, [`${name}: any`]);
}

/** Internal: an override, with the overrides section made right after dependencies. */
function override(text: string, name: string, lines: string[]): string {
	return setEntry(text, 'dependency_overrides', name, lines, ['dependencies']);
}

/** The overrides this CLI wrote because SmartifyOS needed them. */
export function markedOverrides(text: string): string[] {
	return entryNames(text, 'dependency_overrides').filter((name) =>
		entryKeyLine(text, 'dependency_overrides', name)?.includes(neededMarker),
	);
}

/**
 * Points the app at one SmartifyOS, with the overrides that SmartifyOS needs.
 *
 * `previous` names the overrides the SmartifyOS being replaced needed. Those are taken out
 * unless the new one needs them too, so the set always moves together with SmartifyOS.
 * Anything this CLI marked as needed is counted as previous as well.
 */
export function withCore(
	text: string,
	source: GitSource,
	needed: NeededOverride[],
	previous: string[] = [],
): string {
	let result = asAny(text, corePackage);
	result = override(result, corePackage, gitEntry(corePackage, source));

	const neededNames = new Set(needed.map((entry) => entry.name));
	for (const name of new Set([...previous, ...markedOverrides(result)])) {
		if (name !== corePackage && !neededNames.has(name)) {
			result = removeEntry(result, 'dependency_overrides', name);
		}
	}

	for (const entry of needed) {
		const [first = `${entry.name}:`, ...rest] = entry.lines;
		result = override(result, entry.name, [`${first} ${neededMarker}`, ...rest]);
	}

	return result;
}

/** Adds an extension, or moves it to another source. */
export function withExtension(text: string, name: string, source: GitSource): string {
	return override(asAny(text, name), name, gitEntry(name, source));
}

/** Takes an extension out of both sections. */
export function withoutExtension(text: string, name: string): string {
	return removeEntry(removeEntry(text, 'dependency_overrides', name), 'dependencies', name);
}
