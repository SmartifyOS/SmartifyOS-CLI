import { setEntry, yamlScalar } from './blocks.ts';
import { parsePubspec } from './read.ts';

/**
 * A pubspec with these assets among `flutter: assets:`, unless a folder listed there holds
 * them already.
 */
export function withAssets(pubspecText: string, assets: string[]): string {
	const pubspec = parsePubspec(pubspecText, 'pubspec.yaml');
	const flutter = pubspec.flutter as { assets?: unknown } | null | undefined;
	const had = Array.isArray(flutter?.assets) ? flutter.assets.map(String) : [];
	const covered = (asset: string) =>
		had.some((entry) => entry === asset || (entry.endsWith('/') && asset.startsWith(entry)));
	const missing = assets.filter((asset) => !covered(asset));
	if (missing.length === 0) return pubspecText;
	return setEntry(pubspecText, 'flutter', 'assets', [
		'assets:',
		...[...had, ...missing].map((asset) => `  - ${yamlScalar(asset)}`),
	]);
}
