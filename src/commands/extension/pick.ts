import { describeVersion, findInstalled, type Installed } from '../../core/project/car.ts';
import { select } from '../../ui/prompt.ts';
import { CliError } from '../../utils/errors.ts';

/**
 * Internal: the installed extension a command is about, from what the user typed, or asked
 * for from a list when they typed nothing.
 */
export async function pickInstalled(
	extensions: Installed[],
	query: string | undefined,
	message: string,
): Promise<Installed> {
	if (query) {
		const found = findInstalled(extensions, query);
		if (found) return found;
		const names = extensions.map((e) => e.name.replace(/^smartify_os_/, '')).join(', ');
		throw new CliError(`There is no extension called ${query} in this car.`, {
			hint: names ? `It has ${names}.` : 'It has no extensions yet.',
		});
	}

	const choice = await select({
		message,
		options: extensions.map((e) => ({ value: e.name, label: e.title, hint: describeVersion(e) })),
	});
	const picked = extensions.find((e) => e.name === choice);
	if (!picked) throw new CliError('Nothing was picked.');
	return picked;
}
