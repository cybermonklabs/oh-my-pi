#!/usr/bin/env bash
# The reference programs the tests compare against, built once per run from pinned sources and
# shipped to the test jobs as one tarball ($SC/up/sc-tools.tgz, unpacked at / by host.sh):
#   - zsh 5.9 under /usr (/usr/bin/zsh, /usr/share/zsh/5.9, /usr/lib/zsh/5.9): pi-shell's differential
#     pty tests compare obash with it, and return early without it (tests/pty_support have_real_zsh);
#   - rsync 3.5.1 with every checksum and compressor the builtin offers (/opt/sc-ref/bin/rsync):
#     pi-builtins' conformance and daemon tests compare with it byte for byte;
#   - jj 0.46.0, the jj-lib version Cargo.lock pins (/opt/sc-ref/bin/jj): pi-vcs's jj tests.
# The pins are the gate kit's refenv.sh and #61's (not in this base). No tree code runs here.
set -euo pipefail
st=$SC/stage
mkdir -p "$st/opt/sc-ref/bin" "$SC/up" "$SC/src"

fetch() { # <name> <file> <sha256> <url>...: the first url whose bytes have the sha256
	local name=$1 out=$2 sum=$3 u
	shift 3
	for u in "$@"; do
		if curl -fsSL --retry 3 --retry-delay 5 -o "$out" "$u" && echo "$sum  $out" | sha256sum -c - > /dev/null 2>&1; then
			echo "TOOL $name: sha256 ok from $u"
			return 0
		fi
	done
	echo "::error title=Reference tools::$name: no source gave sha256 $sum"
	return 1
}

sudo apt-get -q -o Acquire::Retries=5 update > "$SC/apt.log"
sudo apt-get -q -o Acquire::Retries=5 install -y --no-install-recommends \
	libncurses-dev libxxhash-dev liblz4-dev libzstd-dev libacl1-dev libidn2-dev >> "$SC/apt.log"

fetch "zsh 5.9" "$SC/src/zsh.tar.xz" 9b8d1ecedd5b5e81fbf1918e876752a7dd948e05c1a0dba10ab863842d45acd5 \
	https://downloads.sourceforge.net/project/zsh/zsh/5.9/zsh-5.9.tar.xz \
	https://deb.debian.org/debian/pool/main/z/zsh/zsh_5.9.orig.tar.xz \
	https://www.zsh.org/pub/old/zsh-5.9.tar.xz
fetch "rsync 3.5.1" "$SC/src/rsync.tar.gz" c55f9c9dc10fb8bec397b399a0fdded53cc9a2d8e30891bb0d63724d25c37bef \
	https://www.mirrorservice.org/sites/rsync.samba.org/src/rsync-3.5.1.tar.gz \
	https://download.samba.org/pub/rsync/src/rsync-3.5.1.tar.gz
fetch "jj 0.46.0" "$SC/src/jj.tar.gz" fce0271158e665ceb82dc66c5eb95b1728649094e9133074f3b5baece345fc08 \
	https://github.com/jj-vcs/jj/releases/download/v0.46.0/jj-v0.46.0-x86_64-unknown-linux-musl.tar.gz

(
	cd "$SC/src"
	tar -xJf zsh.tar.xz
	cd zsh-5.9
	# --with-tcsetpgrp: configure probes tcsetpgrp on its own controlling tty, which a runner has
	# none of; Debian's build passes the same flag.
	./configure --prefix=/usr --enable-multibyte --with-tcsetpgrp --with-term-lib='ncursesw tinfo' > "$SC/zsh-configure.log" 2>&1
	make -j "$(nproc)" > "$SC/zsh-make.log" 2>&1
	make DESTDIR="$st" install.bin install.modules install.fns > "$SC/zsh-install.log" 2>&1
) &
zsh_pid=$!
(
	cd "$SC/src"
	tar -xzf rsync.tar.gz
	cd rsync-3.5.1
	./configure --disable-md2man > "$SC/rsync-configure.log" 2>&1
	make -j "$(nproc)" > "$SC/rsync-make.log" 2>&1
	cp rsync "$st/opt/sc-ref/bin/rsync"
) &
rsync_pid=$!
tar -xzf "$SC/src/jj.tar.gz" -C "$st/opt/sc-ref/bin" ./jj
wait "$zsh_pid" || { tail -n 30 "$SC"/zsh-*.log; echo "::error title=Reference tools::the zsh 5.9 build failed"; exit 1; }
wait "$rsync_pid" || { tail -n 30 "$SC"/rsync-*.log; echo "::error title=Reference tools::the rsync 3.5.1 build failed"; exit 1; }
# Owned by root, and only usr/ and opt/ (no ./ entry): host.sh unpacks it at / and keeps the
# host's directories as they are.
tar -C "$st" --owner=0 --group=0 --numeric-owner -czf "$SC/up/sc-tools.tgz" usr opt
echo "TOOLS $(du -k "$SC/up/sc-tools.tgz" | cut -f1) KiB: $(cd "$st" && find . -maxdepth 3 -type d | sort | tr '\n' ' ')"
