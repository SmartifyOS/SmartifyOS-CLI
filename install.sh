#!/bin/sh
#
# Installs the SmartifyOS CLI on macOS and Linux.
#
#   curl -fsSL https://smartify-os.com/install.sh | bash
#
# It downloads one file, checks it against the published checksum, puts it in your home
# folder and adds it to your PATH. It does not need sudo and it does not touch anything
# outside your home folder.
#
# Options, all optional:
#   SMARTIFY_OS_VERSION=v0.2.0     install a specific release instead of the newest
#   SMARTIFY_OS_INSTALL_DIR=/path  install somewhere else
#   SMARTIFY_OS_NO_MODIFY_PATH=1   do not touch your shell config
#   SMARTIFY_OS_BASE_URL=...       download from a mirror instead of GitHub

set -eu

REPO="SmartifyOS/SmartifyOS-CLI"
BIN_NAME="smartify-os"
INSTALL_DIR="${SMARTIFY_OS_INSTALL_DIR:-$HOME/.smartify-os/bin}"
VERSION="${SMARTIFY_OS_VERSION:-latest}"

# Colors, but only when this is a real terminal.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
	BOLD=$(printf '\033[1m')
	DIM=$(printf '\033[2m')
	CYAN=$(printf '\033[36m')
	GREEN=$(printf '\033[32m')
	RED=$(printf '\033[31m')
	RESET=$(printf '\033[0m')
else
	BOLD=''
	DIM=''
	CYAN=''
	GREEN=''
	RED=''
	RESET=''
fi

say() { printf '%s\n' "$1"; }
step() { printf '  %s%s%s %s\n' "$CYAN" "*" "$RESET" "$1"; }
ok() { printf '  %s%s%s %s\n' "$GREEN" "+" "$RESET" "$1"; }

fail() {
	printf '\n  %s%s%s %s\n' "$RED" "!" "$RESET" "$1" >&2
	if [ $# -gt 1 ]; then
		printf '    %s%s%s\n' "$DIM" "$2" "$RESET" >&2
	fi
	printf '\n' >&2
	exit 1
}

need() {
	command -v "$1" >/dev/null 2>&1
}

# --- Work out which build this machine needs ---------------------------------

# Sets TARGET, for example "linux-arm64" or "linux-x64-musl". This sets a variable rather
# than printing, because `fail` inside a $(...) would only kill the subshell.
detect_target() {
	os=$(uname -s)
	arch=$(uname -m)

	case "$os" in
	Darwin) os_name="darwin" ;;
	Linux) os_name="linux" ;;
	*) fail "SmartifyOS does not have a build for $os." "It runs on macOS, Linux and Windows." ;;
	esac

	case "$arch" in
	x86_64 | amd64) arch_name="x64" ;;
	arm64 | aarch64) arch_name="arm64" ;;
	*) fail "SmartifyOS does not have a build for $arch." "It runs on 64 bit Intel and ARM." ;;
	esac

	# Alpine and other musl systems need their own build, a glibc binary will not start.
	# On musl, ldd prints its name to stderr and exits non zero, hence the 2>&1 and the ||.
	libc=""
	if [ "$os_name" = "linux" ] && { ldd --version 2>&1 || true; } | grep -qi musl; then
		libc="-musl"
	fi

	TARGET="$os_name-$arch_name$libc"
}

# --- Download ----------------------------------------------------------------

download() {
	url="$1"
	dest="$2"
	if need curl; then
		curl -fsSL "$url" -o "$dest"
	elif need wget; then
		wget -qO "$dest" "$url"
	else
		fail "Neither curl nor wget is installed." "Install one of them and run this again."
	fi
}

checksum() {
	file="$1"
	if need sha256sum; then
		sha256sum "$file" | cut -d' ' -f1
	elif need shasum; then
		shasum -a 256 "$file" | cut -d' ' -f1
	else
		printf ''
	fi
}

# --- Put the binary on the PATH ----------------------------------------------

# Adds the install dir to one shell config file, but only once. The marker comment is what
# makes running this installer again safe.
add_to_shell_config() {
	config="$1"
	line="$2"
	marker="# added by the SmartifyOS installer"

	[ -f "$config" ] || return 0
	grep -qF "$marker" "$config" && return 0

	printf '\n%s\n%s\n' "$marker" "$line" >>"$config"
	ok "added it to $(basename "$config")"
}

# Sets PATH_STATUS to one of:
#   ready     the install dir is already on PATH, the command works right now
#   changed   shell configs were updated, it works in a new terminal
#   manual    the user asked us not to touch anything, they have to do it
setup_path() {
	case ":$PATH:" in
	*":$INSTALL_DIR:"*)
		PATH_STATUS="ready"
		return 0
		;;
	esac

	if [ -n "${SMARTIFY_OS_NO_MODIFY_PATH:-}" ]; then
		PATH_STATUS="manual"
		return 0
	fi

	posix_line="export PATH=\"$INSTALL_DIR:\$PATH\""
	add_to_shell_config "$HOME/.zshrc" "$posix_line"
	add_to_shell_config "$HOME/.bashrc" "$posix_line"
	add_to_shell_config "$HOME/.bash_profile" "$posix_line"
	add_to_shell_config "$HOME/.profile" "$posix_line"

	if [ -f "$HOME/.config/fish/config.fish" ]; then
		add_to_shell_config "$HOME/.config/fish/config.fish" "fish_add_path \"$INSTALL_DIR\""
	fi

	PATH_STATUS="changed"
}

# --- Do it -------------------------------------------------------------------

main() {
	say ""
	say "  ${BOLD}${CYAN}SmartifyOS${RESET} ${DIM}installer${RESET}"
	say ""

	detect_target
	step "your system: $TARGET"

	if [ -n "${SMARTIFY_OS_BASE_URL:-}" ]; then
		base="$SMARTIFY_OS_BASE_URL"
	elif [ "$VERSION" = "latest" ]; then
		base="https://github.com/$REPO/releases/latest/download"
	else
		base="https://github.com/$REPO/releases/download/$VERSION"
	fi

	archive="$BIN_NAME-$TARGET.tar.gz"

	tmp=$(mktemp -d 2>/dev/null || mktemp -d -t smartify-os)
	trap 'rm -rf "$tmp"' EXIT INT TERM

	step "downloading $VERSION"
	download "$base/$archive" "$tmp/$archive" ||
		fail "Could not download $archive." "Check https://github.com/$REPO/releases to see what is published."

	# The checksum file covers every archive in the release, so pull out our line.
	if download "$base/checksums.txt" "$tmp/checksums.txt" 2>/dev/null; then
		expected=$(grep " $archive\$" "$tmp/checksums.txt" | cut -d' ' -f1 || printf '')
		actual=$(checksum "$tmp/$archive")
		if [ -n "$expected" ] && [ -n "$actual" ] && [ "$expected" != "$actual" ]; then
			fail "The download does not match its checksum." "Something went wrong on the way. Please try again."
		fi
		[ -n "$expected" ] && [ -n "$actual" ] && ok "checksum matches"
	fi

	step "installing"
	tar -xzf "$tmp/$archive" -C "$tmp" ||
		fail "Could not unpack $archive."

	[ -f "$tmp/$BIN_NAME" ] ||
		fail "The download did not contain $BIN_NAME."

	mkdir -p "$INSTALL_DIR"
	chmod +x "$tmp/$BIN_NAME"
	mv -f "$tmp/$BIN_NAME" "$INSTALL_DIR/$BIN_NAME"
	ok "put it in $INSTALL_DIR"

	# Keep stderr, do not throw it away. When this fails it is usually a missing system
	# library, and the loader message naming it is the only useful thing on screen.
	if ! installed=$("$INSTALL_DIR/$BIN_NAME" --version 2>"$tmp/run.log"); then
		if grep -q "libstdc++\|libgcc_s" "$tmp/run.log" 2>/dev/null; then
			# Alpine and other musl systems do not ship libstdc++, and SmartifyOS needs it.
			fail "SmartifyOS needs libstdc++, which is not installed." \
				"On Alpine run: apk add libstdc++"
		fi
		printf '\n' >&2
		sed 's/^/    /' "$tmp/run.log" >&2
		fail "The installed binary does not run on this machine." "Please open an issue at https://github.com/$REPO/issues"
	fi
	ok "SmartifyOS CLI $installed"

	PATH_STATUS="ready"
	setup_path

	say ""
	case "$PATH_STATUS" in
	ready)
		say "  ${BOLD}All set.${RESET} Run:"
		say ""
		say "    ${CYAN}$BIN_NAME${RESET}"
		;;
	changed)
		say "  ${BOLD}Almost there.${RESET} Open a new terminal, then run:"
		say ""
		say "    ${CYAN}$BIN_NAME${RESET}"
		;;
	manual)
		say "  ${BOLD}Almost there.${RESET} Add this to your shell config:"
		say ""
		say "    ${CYAN}export PATH=\"$INSTALL_DIR:\$PATH\"${RESET}"
		;;
	esac
	say ""
}

main
