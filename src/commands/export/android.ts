import { copyFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runOrThrow } from '../../core/process.ts';
import { requireCar } from '../../core/project/find.ts';
import { prepareAndroid } from '../../ui/android.ts';
import { intro, outro } from '../../ui/output.ts';
import { readCarStep, step } from '../../ui/project.ts';
import { note } from '../../ui/prompt.ts';
import { theme } from '../../ui/theme.ts';
import { binaryName } from '../flags.ts';
import type { Command } from '../types.ts';
import { pickTarget } from './shared.ts';

/** Where Flutter puts the app it builds for Android. */
const builtApk = join('build', 'app', 'outputs', 'flutter-apk', 'app-release.apk');

/**
 * Builds the car's app for an Android tablet or phone, and puts the app file on a USB stick
 * or in a folder, to install on it.
 */
export const exportAndroidCommand: Command = {
	name: 'android',
	aliases: ['apk'],
	summary: 'Put your car as an Android app on a USB stick',
	description:
		"Builds your car's app for an Android tablet or phone that is the car's screen, and puts it on a USB stick or in a folder as an .apk file, which you open on the tablet to install. What SmartifyOS and your extensions need on Android is set up for you. The first build takes a while, ten minutes or more. Run it in your car's app folder.",
	examples: [`${binaryName} export android`, `${binaryName} export android --to ~/Desktop`],
	flags: {
		to: {
			type: 'string',
			describe: 'The USB stick to put it on, or any folder',
		},
	},
	async run({ flags }) {
		intro('Make an Android app');
		const app = await requireCar();
		const state = await readCarStep(app);
		const sync = await prepareAndroid(state, flags.yes === true);
		const target = await pickTarget(flags.to);

		await step(
			'Building it for Android (ten minutes or more the first time)',
			() =>
				runOrThrow(
					'flutter',
					['build', 'apk', '--release'],
					{
						message: "Your car's app did not build for Android.",
						hint: 'The end of what Flutter printed says why:',
					},
					{ cwd: app.dir },
				),
			() => 'Built it for Android',
		);

		const name = /^name:\s*(\S+)/m.exec(state.pubspecText)?.[1] ?? 'smartify_os_app';
		const file = join(target, `${name}.apk`);
		await step(
			'Putting it on the stick',
			() => copyFile(join(app.dir, builtApk), file),
			() => `Written to ${theme.code(file)}`,
		);
		const size = (await stat(file)).size;

		note(
			[
				`1. Plug the stick into the tablet, and open ${theme.code(`${name}.apk`)} on it in Files.`,
				'2. Allow installing apps from Files when Android asks, once.',
				'3. Tap Install. An update installs over the one there, keeping its settings.',
			].join('\n'),
			'On the tablet',
		);
		outro('All done.');
		return { changed: true, file, size, android: sync.changed };
	},
};
