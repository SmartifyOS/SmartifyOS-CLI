import { join } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import { runOrThrow } from '../process.ts';
import { gradleFiles } from './project.ts';

/**
 * Building the car's app for Android as one `.apk` file, which `export android` puts on a
 * stick and `tablet` installs over USB, and the name Android knows the app by.
 */

/** Where Flutter puts the app it builds for Android, relative to the app. */
export const builtApk = join('build', 'app', 'outputs', 'flutter-apk', 'app-release.apk');

/**
 * Builds the car's app for Android, in release mode.
 *
 * @returns the full path of the `.apk`.
 * @throws {CliError} when it did not build, with the end of what Flutter printed.
 */
export async function buildApk(appDir: string): Promise<string> {
	await runOrThrow(
		'flutter',
		['build', 'apk', '--release'],
		{
			message: "Your car's app did not build for Android.",
			hint: 'The end of what Flutter printed says why:',
		},
		{ cwd: appDir },
	);
	return join(appDir, builtApk);
}

/** The `applicationId` written in one build.gradle(.kts), when it is written as plain text. */
export function applicationIdIn(gradle: string): string | undefined {
	return /^\s*applicationId\s*=?\s*["']([\w.]+)["']/m.exec(gradle)?.[1];
}

/**
 * The name Android knows the car's app by, its `applicationId` in `android/app/build.gradle(.kts)`.
 *
 * @throws {CliError} when the app has no Android part, or the id is written as code.
 */
export async function readApplicationId(appDir: string): Promise<string> {
	for (const path of gradleFiles) {
		const file = Bun.file(join(appDir, path));
		if (!(await file.exists())) continue;
		const id = applicationIdIn(await file.text());
		if (id) return id;
		throw new CliError(`The applicationId in ${path} is not written as plain text.`, {
			hint: 'Write it as applicationId = "com.example.my_car", the way Flutter does.',
		});
	}
	throw new CliError("Your car's app has no Android part yet.", {
		hint: 'Run smartify-os run --android, which adds it.',
	});
}
