import { constructorCall, importLine, type SwitchResult } from '../core/project/main-dart.ts';
import { log } from './output.ts';
import { theme } from './theme.ts';

/**
 * What the owner is told about `lib/main.dart` after adding or removing an extension. When
 * the CLI could not edit it, the exact lines to change, so nothing is left to guesswork.
 */

export function renderSwitchOn(result: SwitchResult | undefined, packageName: string): void {
	if (!result || result.kind === 'already') return;

	if (result.kind === 'done') {
		log.success(`Switched it on in ${theme.code('lib/main.dart')}`);
		return;
	}

	if (result.kind === 'unknown') {
		log.warn(
			`Switch it on in ${theme.code('lib/main.dart')}, the way its README says. Its import starts with ${theme.code(`package:${packageName}/`)}.`,
		);
		return;
	}

	log.warn(
		[
			`Switch it on in ${theme.code('lib/main.dart')}. Add this import at the top:`,
			`  ${theme.code(importLine(result.entry))}`,
			'and add it to the extensions you hand to SmartifyOs().init:',
			`  ${theme.code(`extensions: [${constructorCall(result.entry)}],`)}`,
		].join('\n'),
	);
}

export function renderSwitchOff(result: SwitchResult | undefined): void {
	if (result?.kind === 'done') log.success(`Took it out of ${theme.code('lib/main.dart')}`);
}
