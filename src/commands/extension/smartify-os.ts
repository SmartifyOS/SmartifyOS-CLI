import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { extensionOverrides } from '../../core/extension/create.ts';
import { isReleaseTag, neededOverrides, newestCore } from '../../core/smartify-os.ts';
import { log } from '../../ui/output.ts';
import { step } from '../../ui/project.ts';
import { theme } from '../../ui/theme.ts';

/**
 * An extension fresh from GitHub has no `pubspec_overrides.yaml`, since it is never
 * committed, and without it pub looks for SmartifyOS on pub.dev and finds nothing. So one is
 * written for the newest SmartifyOS, in the extension and in its example.
 */
export async function findSmartifyOs(dir: string): Promise<void> {
	const own = join(dir, 'pubspec_overrides.yaml');
	const example = join(dir, 'example', 'pubspec_overrides.yaml');
	const hasExample = existsSync(join(dir, 'example', 'pubspec.yaml'));
	if (existsSync(own) && (existsSync(example) || !hasExample)) return;

	const core = await step('Finding SmartifyOS for it', () => newestCore());
	const location = { kind: 'git', source: core.source } as const;
	if (!existsSync(own)) await Bun.write(own, extensionOverrides(location));
	if (hasExample && !existsSync(example)) {
		await Bun.write(example, extensionOverrides(location, neededOverrides(core.pubspecText)));
	}
	const label = isReleaseTag(core.source.ref) ? core.version : core.source.ref;
	log.info(`It uses SmartifyOS ${theme.strong(label)}, the newest.`);
}
