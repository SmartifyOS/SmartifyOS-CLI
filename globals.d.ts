/**
 * Short git commit the binary was built from. Injected at build time by
 * scripts/build.ts with `--define`. It is `'dev'` when running from source.
 */
declare const __BUILD_SHA__: string;

/**
 * The release target this binary was compiled for, for example `linux-x64-musl`. Injected
 * at build time by scripts/build.ts with `--define`, so that the update command never has
 * to guess which of the published builds belongs on this machine. It is `'dev'` when
 * running from source.
 */
declare const __BUILD_TARGET__: string;

/**
 * A shell script imported as text, `import script from './linux.sh' with { type: 'text' }`,
 * which `bun build --compile` puts inside the binary.
 */
declare module '*.sh' {
	const text: string;
	export default text;
}
