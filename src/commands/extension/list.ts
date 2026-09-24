import { displayUrl } from '../../core/git.ts';
import { describeVersion, findEntry, type Installed, readCar } from '../../core/project/car.ts';
import { carFiles, requireCar } from '../../core/project/find.ts';
import { isSwitchedOn } from '../../core/project/main-dart.ts';
import { writeLine } from '../../ui/output.ts';
import { theme } from '../../ui/theme.ts';
import { binaryName } from '../flags.ts';
import type { Command } from '../types.ts';

/**
 * Lists what the car runs: its SmartifyOS and every extension, with versions.
 *
 * Printed as plain lines rather than inside a prompt session, since this is output someone
 * might want to copy into a bug report or pipe somewhere.
 */
export const extensionListCommand: Command = {
	name: 'list',
	aliases: ['ls'],
	summary: 'List the extensions in your car',
	description:
		"Lists which SmartifyOS your car runs and every extension in it, with its version, or its commit for one without releases. Run it in your car's app folder.",
	examples: [`${binaryName} extension list`],
	async run() {
		const app = await requireCar();
		const state = await readCar(app);
		const main = Bun.file(carFiles(app).main);
		const mainText = (await main.exists()) ? await main.text() : undefined;

		const rows: [string, string, string][] = [
			['SmartifyOS', describeVersion(state.core), where(state.core)],
		];
		const notes: string[] = [];

		for (const extension of state.extensions) {
			rows.push([extension.title, describeVersion(extension), where(extension)]);
			const entry = extension.root ? await findEntry(extension.name, extension.root) : undefined;
			if (entry && mainText !== undefined && !isSwitchedOn(mainText, entry)) {
				notes.push(`${extension.title} is not switched on in lib/main.dart.`);
			}
		}

		const nameWidth = Math.max(...rows.map((row) => row[0].length));
		const versionWidth = Math.max(...rows.map((row) => row[1].length));

		writeLine();
		rows.forEach(([name, version, from], index) => {
			const label =
				index === 0 ? theme.brand(theme.strong(name.padEnd(nameWidth))) : name.padEnd(nameWidth);
			writeLine(`  ${label}  ${version.padEnd(versionWidth)}  ${theme.dim(from)}`);
		});
		if (state.extensions.length === 0) {
			writeLine();
			writeLine(
				`  ${theme.dim(`No extensions yet. Add one with ${binaryName} extension add <url>.`)}`,
			);
		}
		for (const note of notes) {
			writeLine();
			writeLine(`  ${theme.warn(note)}`);
		}
		writeLine();
	},
};

/** Internal: where a package comes from, in a few words. */
function where(installed: Installed): string {
	if (installed.link) return 'linked';
	const source = installed.source;
	if (source.kind === 'git') return displayUrl(source.url);
	if (source.kind === 'path') return 'a folder on this computer';
	return '';
}
