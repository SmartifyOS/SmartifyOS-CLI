#!/usr/bin/env bash
#
# What SmartifyOS does on a Linux machine: the car, or a machine that builds for one.
#
# Written next to the car's app by `smartify-os export`. install.sh runs it on a new car,
# SmartifyOS runs it when it applies an update, and it runs on any machine that builds for
# a car. They all run this same step, so there is never a second way of doing it that could
# drift apart from this one.
#
#   linux.sh packages <set> [--user NAME] [--bundle DIR] [--keep-unused]
#       Installs a package set (a folder smartify-os wrote, see src/core/linux/set.ts) as
#       one generated .deb, so apt knows exactly what SmartifyOS pulled in. With --bundle,
#       the libraries that build links against are added to it.
#   linux.sh libraries <bundle>
#       Prints, as apt.list lines, the packages owning the libraries a build links against.
#   linux.sh check <bundle>
#       Fails, saying which, when a library the build needs is not on this machine.
#   linux.sh flutter <version> <dir> [--user NAME]
#       Installs Flutter at that version into dir.
#   linux.sh build <app> --flutter <dir> [--user NAME]
#       Builds the car's app for Linux, and prints the folder of the finished build.
#
# It never asks anything. Installing needs root, or sudo that asks for no password.

set -euo pipefail
export LC_ALL=C

# -- Output ------------------------------------------------------------------------------

if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
	c_step=$'\033[1;36m' c_warn=$'\033[1;33m' c_err=$'\033[1;31m' c_dim=$'\033[2m' c_off=$'\033[0m'
else
	c_step='' c_warn='' c_err='' c_dim='' c_off=''
fi

# Everything for a person goes to stderr, so stdout is free for what a command hands back.
step() { printf '%s==>%s %s\n' "$c_step" "$c_off" "$*" >&2; }
info() { printf '    %s\n' "$*" >&2; }
dim() { printf '    %s%s%s\n' "$c_dim" "$*" "$c_off" >&2; }
warn() { printf '%s  ! %s%s\n' "$c_warn" "$*" "$c_off" >&2; }

# fail <what went wrong> [what to do about it]
fail() {
	printf '%s  x %s%s\n' "$c_err" "$1" "$c_off" >&2
	if [ -n "${2:-}" ]; then printf '    %s\n' "$2" >&2; fi
	exit 1
}

# -- Helpers -----------------------------------------------------------------------------

# conf_get <file> <key>: one value of a KEY=value file, never sourced, so it runs nothing.
conf_get() {
	awk -v key="$2" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$1"
}

# The architecture of this machine, in SmartifyOS's words, or nothing for one it does not run on.
machine_arch() {
	case "$(dpkg --print-architecture 2>/dev/null || uname -m)" in
	amd64 | x86_64) echo x64 ;;
	arm64 | aarch64) echo arm64 ;;
	*) echo '' ;;
	esac
}

# The user SmartifyOS runs as, which files are made for and groups are joined by.
run_user=''

# Set by smartify-os when somebody is at the terminal who can type a password for sudo.
# Everywhere else sudo is never allowed to ask.
sudo_can_ask=${SMARTIFY_OS_SUDO_ASK:-0}

as_root() {
	if [ "$(id -u)" -eq 0 ]; then
		"$@"
	elif [ "$sudo_can_ask" = 1 ]; then
		sudo "$@"
	else
		sudo -n "$@"
	fi
}

# Fails with a hint, rather than waiting for a password nobody can type.
need_root() {
	if [ "$(id -u)" -eq 0 ]; then return 0; fi
	if command -v sudo >/dev/null 2>&1; then
		if sudo -n true 2>/dev/null; then return 0; fi
		if [ "$sudo_can_ask" = 1 ] && sudo -v; then return 0; fi
	fi
	fail 'Installing needs root, and sudo here asks for a password.' \
		'Run this as root, or as a user sudo lets in without a password, which the SmartifyOS installer sets up on a car.'
}

as_user() {
	if [ -z "$run_user" ] || [ "$(id -un)" = "$run_user" ]; then
		"$@"
		return
	fi
	local home
	home=$(getent passwd "$run_user" | cut -d: -f6)
	if [ "$(id -u)" -eq 0 ]; then
		runuser -u "$run_user" -- env HOME="$home" USER="$run_user" LOGNAME="$run_user" PATH="$PATH" "$@"
	else
		sudo -n -u "$run_user" env HOME="$home" USER="$run_user" LOGNAME="$run_user" PATH="$PATH" "$@"
	fi
}

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi
}

# apt_entries <file|-> <arch>: "package<TAB>who" for each entry of an apt.list that applies
# on this architecture.
apt_entries() {
	awk -F'\t' -v arch="$2" '
		/^#/ || $1 == "" { next }
		{
			ok = ($2 == "*" || $2 == "")
			n = split($2, list, ",")
			for (i = 1; i <= n; i++) if (list[i] == arch) ok = 1
			if (ok) print $1 "\t" $3
		}' "$1"
}

# Merges "package<TAB>who" lines of the same package, sorted by package.
merge_entries() {
	awk -F'\t' '
		$1 == "" { next }
		{
			if ($1 in who) {
				if (index(", " who[$1] ", ", ", " $2 ", ") == 0 && $2 != "") who[$1] = who[$1] ", " $2
			} else {
				who[$1] = $2
				order[++n] = $1
			}
		}
		END { for (i = 1; i <= n; i++) print order[i] "\t" who[order[i]] }' | sort
}

# Keeps the lines whose package name is one apt could ever take, warning about the rest.
valid_names() {
	local name who
	while IFS="$(printf '\t')" read -r name who; do
		if grep -Eq '^[a-z0-9][a-z0-9+.-]+$' <<<"$name"; then
			printf '%s\t%s\n' "$name" "$who"
		else
			warn "${who:-Someone} asks for \"$name\", which is not a package name. It was left out."
		fi
	done
}

# Which of the given packages are installed, one per line.
installed_of() {
	# dpkg-query exits non zero when one of them is unknown, which is fine here.
	dpkg-query -W -f='${db:Status-Abbrev}\t${Package}\n' "$@" 2>/dev/null | awk -F'\t' '$1 ~ /^ii/ { print $2 }' || true
}

# Which of the given packages apt can install, one per line.
known_of() {
	apt-cache policy "$@" 2>/dev/null | awk '
		/^[^ ]/ { name = $1; sub(/:$/, "", name) }
		/^  Candidate:/ { if ($2 != "(none)") print name }'
}

# -- Libraries a build links against ------------------------------------------------------

is_elf() {
	[ -f "$1" ] && [ "$(head -c 4 "$1" 2>/dev/null)" = $'\177ELF' ]
}

# Every program and library of a Flutter bundle.
bundle_files() {
	local file
	for file in "$1"/* "$1"/lib/*; do
		if is_elf "$file"; then printf '%s\n' "$file"; fi
	done
}

# The libraries one file asks for by name (DT_NEEDED).
needed_libs() {
	if command -v readelf >/dev/null 2>&1; then
		readelf -d "$1" 2>/dev/null | sed -n 's/.*(NEEDED).*\[\(.*\)\].*/\1/p'
	elif command -v objdump >/dev/null 2>&1; then
		objdump -p "$1" 2>/dev/null | awk '$1 == "NEEDED" { print $2 }'
	else
		# Without binutils, everything the loader pulls in, which only adds packages the
		# direct ones depend on anyway.
		ldd "$1" 2>/dev/null | awk '$2 == "=>" { print $1 }'
	fi
}

# The package that installed a file. Tries the path as given and as /usr merged systems
# register it, since the loader and dpkg do not always agree on which.
owner_of() {
	local path=$1 real candidate owner
	real=$(readlink -f "$path" 2>/dev/null || printf '%s' "$path")
	for candidate in "$path" "/usr$path" "${path#/usr}" "$real" "/usr$real" "${real#/usr}"; do
		owner=$(dpkg-query -S "$candidate" 2>/dev/null | grep -v '^diversion' | head -n 1 | sed 's/[:,].*//') || true
		if [ -n "$owner" ]; then
			printf '%s\n' "$owner"
			return 0
		fi
	done
	return 1
}

# The Flutter package a plugin library comes from: libaudioplayers_linux_plugin.so is
# audioplayers_linux.
plugin_of() {
	basename "$1" | sed -n 's/^lib\(.*\)_plugin\.so$/\1/p'
}

cmd_libraries() {
	local bundle=${1:-} file lib path owner resolved name
	[ -n "$bundle" ] && [ -d "$bundle" ] || fail "There is no build in ${bundle:-(nothing given)}."

	bundle_files "$bundle" | while IFS= read -r file; do
		name=$(basename "$file")
		resolved=$(ldd "$file" 2>/dev/null || true)
		for lib in $(needed_libs "$file"); do
			# Shipped inside the build: the engine, the app, every plugin.
			if [ -e "$bundle/lib/$lib" ]; then continue; fi
			# `libfoo.so.1 => /usr/lib/.../libfoo.so.1`, or for the loader itself, which arm64
			# names as a library, just `/lib/ld-linux-aarch64.so.1`.
			path=$(awk -v lib="$lib" '
				found { next }
				$1 == lib && $2 == "=>" && $3 ~ /^\// { print $3; found = 1; next }
				$1 ~ /^\// && substr($1, length($1) - length(lib)) == "/" lib { print $1; found = 1 }' <<<"$resolved")
			if [ -z "$path" ]; then
				warn "$name needs $lib, which is not on this machine."
				continue
			fi
			case "$path" in "$bundle"/*) continue ;; esac
			if ! owner=$(owner_of "$path"); then
				warn "$name needs $lib ($path), which no package installed, so it cannot be installed on a car."
				continue
			fi
			printf '%s\t%s\n' "$owner" "$name"
		done
	done | merge_entries | awk -F'\t' '{ print $1 "\t*\t" $2 }'
}

cmd_check() {
	local bundle=${1:-} file lib plugin missing=0
	[ -n "$bundle" ] && [ -d "$bundle" ] || fail "There is no build in ${bundle:-(nothing given)}."

	while IFS= read -r file; do
		for lib in $(ldd "$file" 2>/dev/null | awk '$2 == "=>" && $3 == "not" { print $1 }'); do
			# A plugin finds what the build ships (the engine above all) through the program
			# that loads it, which ldd on the plugin alone cannot know.
			if [ -e "$bundle/lib/$lib" ]; then continue; fi
			missing=1
			plugin=$(plugin_of "$file")
			if [ -n "$plugin" ]; then
				warn "$lib is missing. The Flutter package $plugin needs it ($(basename "$file")), and it is not listed anywhere."
			else
				warn "$lib is missing, which $(basename "$file") needs."
			fi
		done
	done < <(bundle_files "$bundle")
	if [ "$missing" -ne 0 ]; then
		fail 'SmartifyOS would not start on this machine, because of the missing libraries above.' \
			'Tell the author of the package that needs one. Until then, apt install the package that has it.'
	fi
	return 0
}

# -- Package sets -------------------------------------------------------------------------

# The libstdc++ -dev package matching the GCC clang picks, which Flutter builds against.
# Only known once clang is installed, and it differs between releases.
libstdcxx_package() {
	local gcc
	command -v clang >/dev/null 2>&1 || return 0
	gcc=$(clang -v 2>&1 | sed -n 's|^Selected GCC installation: .*/\([0-9][0-9]*\)$|\1|p' | tail -n 1) || true
	if [ -n "$gcc" ]; then printf 'libstdc++-%s-dev\n' "$gcc"; fi
}

# The hash of what a set asks for, which the .deb keeps, so the next run knows whether
# anything changed without keeping a record of its own.
set_hash() {
	local work=$1 rule
	{
		cut -f1 "$work/wanted"
		while IFS="$(printf '\t')" read -r rule _; do
			printf 'rule %s\n' "$rule"
			cat "$work/rules/$rule"
		done <"$work/rules.list"
	} | sha256
}

# Packages whose installing on its own would remove something, one per line.
#
# Never `apt-get ... | grep -q` anywhere in here: grep stops reading at the first match, the
# writer dies of SIGPIPE, and pipefail turns a match into a failure.
removing_packages() {
	local name simulated
	for name in "$@"; do
		simulated=$(as_root apt-get install -s "$name" 2>/dev/null || true)
		if grep -q '^Remv ' <<<"$simulated"; then printf '%s\n' "$name"; fi
	done
}

# build_deb <work> <name> <description> <version>
build_deb() {
	local work=$1 name=$2 description=$3 version=$4 pkg depends rule script
	pkg="$work/pkg"
	rm -rf "$pkg"
	mkdir -p "$pkg/DEBIAN" "$pkg/usr/share/smartify-os/$name" "$pkg/usr/lib/udev/rules.d"

	depends=$(cut -f1 "$work/wanted" | paste -sd, - | sed 's/,/, /g')
	{
		printf 'Package: %s\n' "$name"
		printf 'Version: %s\n' "$version"
		printf 'Architecture: all\n'
		printf 'Maintainer: SmartifyOS <smartify-os@localhost>\n'
		printf 'Section: metapackages\n'
		printf 'Priority: optional\n'
		if [ -n "$depends" ]; then printf 'Depends: %s\n' "$depends"; fi
		printf 'Description: Everything %s needs\n' "$description"
		printf ' Made by SmartifyOS on this machine. A new version of it is how SmartifyOS\n'
		printf ' adds and removes what it needs, so leave it installed.\n'
	} >"$pkg/DEBIAN/control"

	# Whatever changed about the rules, udev reads them again.
	for script in postinst postrm; do
		cat >"$pkg/DEBIAN/$script" <<'EOF'
#!/bin/sh
set -e
if command -v udevadm >/dev/null 2>&1 && [ -d /run/udev ]; then
	udevadm control --reload-rules 2>/dev/null || true
	udevadm trigger 2>/dev/null || true
fi
EOF
	done

	while IFS="$(printf '\t')" read -r rule _; do
		cp "$work/rules/$rule" "$pkg/usr/lib/udev/rules.d/$rule"
	done <"$work/rules.list"
	cp "$work/hash" "$pkg/usr/share/smartify-os/$name/hash"
	cp "$work/wanted" "$pkg/usr/share/smartify-os/$name/packages"
	cp "$work/skipped" "$pkg/usr/share/smartify-os/$name/skipped"

	chmod -R u=rwX,go=rX "$pkg"
	chmod 0755 "$pkg/DEBIAN/postinst" "$pkg/DEBIAN/postrm"
	dpkg-deb --build --root-owner-group "$pkg" "$work/$name.deb" >/dev/null
	chmod 0644 "$work/$name.deb"
}

# The version the new .deb gets: newer than the installed one, even on a car whose clock is
# behind, which a car without a clock battery often is.
next_version() {
	local name=$1 installed now
	installed=$(dpkg-query -W -f='${Version}' "$name" 2>/dev/null | sed -n 's/^1\.\([0-9][0-9]*\)$/\1/p') || true
	now=$(date +%s)
	if [ -n "$installed" ] && [ "$installed" -ge "$now" ]; then now=$((installed + 1)); fi
	printf '1.%s\n' "$now"
}

# by_requester <names> <wanted>: "who<TAB>package, package" for the named packages.
by_requester() {
	awk -F'\t' 'NR == FNR { missing[$1] = 1; next }
		($1 in missing) {
			who = ($2 == "" ? "SmartifyOS" : $2)
			if (who in list) list[who] = list[who] ", " $1; else { list[who] = $1; order[++n] = who }
		}
		END { for (i = 1; i <= n; i++) print order[i] "\t" list[order[i]] }' "$1" "$2"
}

cmd_packages() {
	local set='' bundle='' keep_unused=0
	while [ $# -gt 0 ]; do
		case "$1" in
		--user) run_user=${2:-}; shift 2 ;;
		--bundle) bundle=${2:-}; shift 2 ;;
		--keep-unused) keep_unused=1; shift ;;
		-*) fail "linux.sh packages does not take $1." ;;
		*) set=$1; shift ;;
		esac
	done
	[ -n "$set" ] && [ -f "$set/set.conf" ] || fail "There is no package set in ${set:-(nothing given)}."

	local name description toolchain arch work
	name=$(conf_get "$set/set.conf" NAME)
	description=$(conf_get "$set/set.conf" DESCRIPTION)
	toolchain=$(conf_get "$set/set.conf" FLUTTER_TOOLCHAIN)
	grep -Eq '^smartify-os-[a-z]+$' <<<"$name" || fail "$set/set.conf names no package set."
	arch=$(machine_arch)
	[ -n "$arch" ] || fail "SmartifyOS runs on x64 and arm64, this machine is $(dpkg --print-architecture)."

	work=$(mktemp -d)
	chmod 0755 "$work"
	# shellcheck disable=SC2064
	trap "rm -rf '$work'" EXIT

	# What the set asks for on this machine.
	{
		if [ -f "$set/apt.list" ]; then apt_entries "$set/apt.list" "$arch"; fi
		if [ -n "$bundle" ]; then
			step 'Reading which libraries the build links against'
			# Which file of the build needs each one is too much to read, so they are the build's.
			cmd_libraries "$bundle" | awk -F'\t' '{ print $1 "\t" $2 "\tthe build" }' | apt_entries - "$arch"
		fi
	} | valid_names | merge_entries >"$work/wanted"

	mkdir -p "$work/rules"
	: >"$work/rules.list"
	if [ -f "$set/udev.list" ]; then
		local rule who
		while IFS="$(printf '\t')" read -r rule who; do
			case "$rule" in '#'* | '') continue ;; esac
			# The name becomes a path as root, so it has to be only a name.
			if ! grep -Eq '^[0-9][0-9]-[A-Za-z0-9_.-]+\.rules$' <<<"$rule" || [ ! -f "$set/udev/$rule" ]; then
				warn "The udev rule $rule of ${who:-a package} cannot be used. It was left out."
				continue
			fi
			cp "$set/udev/$rule" "$work/rules/$rule"
			printf '%s\t%s\n' "$rule" "$who" >>"$work/rules.list"
		done <"$set/udev.list"
	fi

	local stdcxx=''
	if [ "$toolchain" = 1 ]; then
		stdcxx=$(libstdcxx_package)
		if [ -n "$stdcxx" ]; then add_wanted "$work" "$stdcxx" Flutter; fi
	fi

	cp "$work/wanted" "$work/requested"
	apply_set "$work" "$name" "$description" "$keep_unused"

	# Flutter's libstdc++ can only be named once clang is there, which the set just installed.
	# Asked again from the start, so the next run, which knows it upfront, sees the same set.
	if [ "$toolchain" = 1 ] && [ -z "$stdcxx" ]; then
		stdcxx=$(libstdcxx_package)
		if [ -n "$stdcxx" ]; then
			cp "$work/requested" "$work/wanted"
			add_wanted "$work" "$stdcxx" Flutter
			apply_set "$work" "$name" "$description" "$keep_unused"
		else
			warn 'Could not tell which libstdc++ clang builds against, so Flutter may not build here.'
		fi
	fi

	join_groups "$set"
}

# add_wanted <work> <package> <who>
add_wanted() {
	{ cat "$1/wanted"; printf '%s\t%s\n' "$2" "$3"; } | merge_entries >"$1/wanted.new"
	mv "$1/wanted.new" "$1/wanted"
}

# skip <work> <package> <why>: leaves one package out, and remembers it was, with who asked.
skip() {
	local who
	who=$(awk -F'\t' -v p="$2" '$1 == p { print $2 }' "$1/wanted")
	warn "${who:-SmartifyOS} needs $2, $3 Update ${who:-it}, or tell its author."
	printf '%s\t%s\n' "$2" "$who" >>"$1/skipped"
	awk -F'\t' -v p="$2" '$1 != p' "$1/wanted" >"$1/wanted.new"
	mv "$1/wanted.new" "$1/wanted"
}

# The names in wanted, sorted, one per line.
wanted_names() {
	cut -f1 "$1/wanted" | sort
}

# apply_set <work> <name> <description> <keep-unused>
#
# Stateless: works out from the set alone what to do every time, never from a record of
# what it did before, so a failed or declined install, a fresh SD card or an extension
# that needs something new all sort themselves out on the next run.
apply_set() {
	local work=$1 name=$2 description=$3 keep_unused=$4
	local rule rules_changed=0 installed_hash meta_installed

	# 1. What is there already. Nothing missing means nothing to ask for.
	wanted_names "$work" >"$work/names"
	if [ -s "$work/names" ]; then
		# shellcheck disable=SC2046
		installed_of $(cat "$work/names") | sort | comm -23 "$work/names" - >"$work/missing"
	else
		: >"$work/missing"
	fi
	while IFS="$(printf '\t')" read -r rule _; do
		if ! cmp -s "$work/rules/$rule" "/usr/lib/udev/rules.d/$rule"; then rules_changed=1; fi
	done <"$work/rules.list"
	# What was asked for, before anything is left out, so the same request is recognised
	# as the same next time.
	set_hash "$work" >"$work/hash"
	installed_hash=$(cat "/usr/share/smartify-os/$name/hash" 2>/dev/null || true)
	meta_installed=$(installed_of "$name")
	: >"$work/skipped"
	# The same request as last time: what was left out then (a name this Linux does not
	# have) is not missing now, or every run would try again and fail the same way.
	if [ -n "$meta_installed" ] && [ "$(cat "$work/hash")" = "$installed_hash" ] &&
		[ -s "/usr/share/smartify-os/$name/skipped" ]; then
		cut -f1 "/usr/share/smartify-os/$name/skipped" | sort | comm -23 "$work/missing" - >"$work/missing.new"
		mv "$work/missing.new" "$work/missing"
	fi

	if [ ! -s "$work/missing" ] && [ "$rules_changed" -eq 0 ] &&
		{ [ -z "$meta_installed" ] || [ "$(cat "$work/hash")" = "$installed_hash" ]; }; then
		step "Everything $description needs is installed already"
		# Said every time, so it is not forgotten after the first.
		local skipped who
		if [ -s "/usr/share/smartify-os/$name/skipped" ]; then
			while IFS="$(printf '\t')" read -r skipped who; do
				warn "${who:-SmartifyOS} needs $skipped, which this Linux does not have. Update ${who:-it}, or tell its author."
			done <"/usr/share/smartify-os/$name/skipped"
		fi
		return 0
	fi

	need_root
	step 'Updating the package lists'
	as_root apt-get update -qq ||
		fail 'The package lists could not be updated.' \
			'This needs the internet. Connect to Wi-Fi or a phone hotspot and run it again.'

	# 2. Every name has to exist. One that does not is almost always a typo or a package
	# renamed in a newer release, and apt's own error would not say whose it is.
	local package
	if [ -s "$work/names" ]; then
		# shellcheck disable=SC2046
		known_of $(cat "$work/names") | sort -u >"$work/known"
		comm -23 "$work/names" "$work/known" | while IFS= read -r package; do
			skip "$work" "$package" 'which this Linux does not have.'
		done
	fi

	# 3. Simulate, and never take anything out of the machine to make room.
	build_deb "$work" "$name" "$description" "$(next_version "$name")"
	local simulated removed culprit
	simulated=$(as_root env DEBIAN_FRONTEND=noninteractive apt-get install -s "$work/$name.deb" 2>&1) ||
		fail "What $description needs cannot be installed together." "$(printf '%s\n' "$simulated" | tail -n 15)"
	removed=$(printf '%s\n' "$simulated" | awk '/^Remv / { print $2 }' | paste -sd' ' -)
	if [ -n "$removed" ]; then
		# Leave out whichever asks for it, and install everything else.
		wanted_names "$work" | comm -12 - "$work/missing" >"$work/culprits.in"
		# shellcheck disable=SC2046
		for culprit in $(removing_packages $(cat "$work/culprits.in")); do
			skip "$work" "$culprit" "which would take $removed out of this machine."
		done
		build_deb "$work" "$name" "$description" "$(next_version "$name")"
		simulated=$(as_root env DEBIAN_FRONTEND=noninteractive apt-get install -s "$work/$name.deb" 2>&1) || true
		removed=$(printf '%s\n' "$simulated" | awk '/^Remv / { print $2 }' | paste -sd' ' -)
		if [ -n "$removed" ]; then
			fail "Installing what $description needs would take $removed out of this machine, so nothing was installed." \
				'Something already on it conflicts with SmartifyOS. Remove it yourself if you are sure it is not needed.'
		fi
	fi

	# 4. Say what goes in, by who asked for it, and install it.
	wanted_names "$work" | comm -12 - "$work/missing" >"$work/installing"
	if [ -s "$work/installing" ]; then
		step "Installing what $description needs"
		local who list
		by_requester "$work/installing" "$work/wanted" | while IFS="$(printf '\t')" read -r who list; do
			info "For $who: $list"
		done
	else
		step "Updating the list of what $description needs"
	fi
	as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$work/$name.deb" >&2 ||
		fail "What $description needs could not be installed." 'What apt printed above says why. Run this again once that is sorted.'

	if [ "$rules_changed" -ne 0 ]; then
		info 'If a device these udev rules are for is plugged in, unplug it and plug it back in.'
	fi

	# 5. What it needed before and needs no more goes. Anything installed by hand stays,
	# since apt marks that as wanted for itself.
	local unused
	unused=$(as_root apt-get autoremove -s 2>/dev/null | awk '/^Remv / { print $2 }' | paste -sd' ' -)
	if [ -n "$unused" ]; then
		if [ "$keep_unused" -eq 1 ]; then
			info "No longer needed: $unused. sudo apt autoremove takes them out."
		else
			step 'Removing what is no longer needed'
			info "$unused"
			as_root env DEBIAN_FRONTEND=noninteractive apt-get autoremove -y -q >&2 || warn 'That did not work, they stay for now.'
		fi
	fi
}

# Adds the user to every group the set lists. Groups are never taken away: that is harmless,
# and the owner may have added one themselves.
join_groups() {
	local set=$1 group who joined=''
	[ -f "$set/groups.list" ] || return 0
	while IFS="$(printf '\t')" read -r group who; do
		case "$group" in '#'* | '') continue ;; esac
		if [ -z "$run_user" ]; then
			warn "${who:-SmartifyOS} needs the user in the group $group, but no user was given."
			continue
		fi
		if grep -Fxq "$group" <<<"$(id -nG "$run_user" | tr ' ' '\n')"; then continue; fi
		need_root
		as_root groupadd -f "$group"
		as_root usermod -aG "$group" "$run_user"
		joined="$joined $group"
	done <"$set/groups.list"
	if [ -n "$joined" ]; then
		step "$run_user joined the groups$joined"
		info 'That takes effect the next time they log in.'
	fi
}

# -- Flutter and building -----------------------------------------------------------------

cmd_flutter() {
	local version='' dir='' current
	while [ $# -gt 0 ]; do
		case "$1" in
		--user) run_user=${2:-}; shift 2 ;;
		-*) fail "linux.sh flutter does not take $1." ;;
		*) if [ -z "$version" ]; then version=$1; else dir=$1; fi; shift ;;
		esac
	done
	[ -n "$version" ] && [ -n "$dir" ] || fail 'linux.sh flutter needs a version and a folder.'

	current=$(as_user git -C "$dir" describe --tags --exact-match 2>/dev/null || true)
	if [ -x "$dir/bin/flutter" ] && [ "$current" = "$version" ]; then
		step "Flutter $version is installed already"
		return 0
	fi

	step "Installing Flutter $version (this takes a while)"
	as_user rm -rf "$dir"
	as_user git clone --quiet --depth 1 --branch "$version" https://github.com/flutter/flutter.git "$dir" ||
		fail "Flutter $version could not be downloaded." 'This needs the internet. Connect to Wi-Fi or a phone hotspot and run it again.'
	as_user "$dir/bin/flutter" --disable-analytics >/dev/null 2>&1 || true
	as_user "$dir/bin/flutter" precache --linux >&2 ||
		fail "Flutter $version could not be set up." 'What it printed above says why.'
}

cmd_build() {
	local app='' flutter_dir='' arch bundle
	while [ $# -gt 0 ]; do
		case "$1" in
		--user) run_user=${2:-}; shift 2 ;;
		--flutter) flutter_dir=${2:-}; shift 2 ;;
		-*) fail "linux.sh build does not take $1." ;;
		*) app=$1; shift ;;
		esac
	done
	[ -n "$app" ] && [ -f "$app/pubspec.yaml" ] || fail "There is no car's app in ${app:-(nothing given)}."
	[ -n "$flutter_dir" ] && [ -x "$flutter_dir/bin/flutter" ] || fail "There is no Flutter in ${flutter_dir:-(nothing given)}."
	arch=$(machine_arch)

	cd "$app"
	export PATH="$flutter_dir/bin:$PATH"
	step 'Fetching packages'
	as_user flutter pub get >&2 ||
		fail "The car's packages could not be fetched." 'This needs the internet. Connect to Wi-Fi or a phone hotspot and run it again.'
	step 'Building SmartifyOS (this takes a few minutes the first time)'
	as_user flutter build linux --release >&2 || fail 'SmartifyOS did not build.' 'What Flutter printed above says why.'

	bundle="$app/build/linux/$arch/release/bundle"
	[ -d "$bundle" ] || fail "The build finished, but there is nothing in $bundle."
	printf '%s\n' "$bundle"
}

# -- Entry --------------------------------------------------------------------------------

usage() {
	sed -n '3,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
}

main() {
	local command=${1:-}
	if [ $# -gt 0 ]; then shift; fi
	case "$command" in
	packages) cmd_packages "$@" ;;
	libraries) cmd_libraries "$@" ;;
	check) cmd_check "$@" ;;
	flutter) cmd_flutter "$@" ;;
	build) cmd_build "$@" ;;
	-h | --help | help) usage ;;
	*)
		usage
		exit 1
		;;
	esac
}

# Sourced by install.sh and the tests for its helpers, run for everything else.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
