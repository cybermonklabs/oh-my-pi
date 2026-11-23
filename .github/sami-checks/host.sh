#!/usr/bin/env bash
# A test job's host: the reference tools (tools.sh's tarball) unpacked at /, the locales and the
# terminfo entry the tests read, fs.protected_* as a hardened host sets them, a temporary
# directory per user on a loop-mounted XFS with reflinks (pi-iso and pi-vcs clone with FICLONE),
# and the sticky-directory FIFO the FIFO tests open as the runner's user (PI_TEST_STICKY_FIFO:
# mode 0666, uid 65534, in a 1777 directory of root's, as sami-rust-test.yml's rust_test sets it up).
# Then the reference environment's checks (the gate kit's refenv.sh check): a host that misses a
# part fails here by name, so its tests do not return early and pass having compared nothing.
#   host.sh TOOLS_TGZ
set -euo pipefail
fail() { echo "::error title=Test host::$*"; exit 1; }
tgz=$1
[ -s "$tgz" ] || fail "no reference tools tarball at $tgz: the tools job failed"
# --no-overwrite-dir: the tarball's directories (usr, usr/bin, opt...) keep the host's owner and mode.
sudo tar -C / --no-overwrite-dir -xzf "$tgz"

sudo locale-gen en_US.UTF-8 sv_SE.UTF-8 de_DE.UTF-8 > /dev/null
sudo sysctl -q -w fs.protected_fifos=1 fs.protected_regular=2 fs.protected_symlinks=1 fs.protected_hardlinks=1

if ! command -v mkfs.xfs > /dev/null; then
	sudo apt-get -q -o Acquire::Retries=5 update > /dev/null
	sudo apt-get -q -o Acquire::Retries=5 install -y --no-install-recommends xfsprogs > /dev/null
fi
truncate -s 12G "$RUNNER_TEMP/sc-reflink.img"
mkfs.xfs -q -m reflink=1 "$RUNNER_TEMP/sc-reflink.img"
sudo mkdir -p /mnt/sc
sudo mount -o loop "$RUNNER_TEMP/sc-reflink.img" /mnt/sc
sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0755 /mnt/sc/tmp-runner
sudo install -d -o root -g root -m 0755 /mnt/sc/tmp-root
echo probe > /mnt/sc/tmp-runner/p && cp --reflink=always /mnt/sc/tmp-runner/p /mnt/sc/tmp-runner/p2 ||
	fail "/mnt/sc takes no reflink"
rm -f /mnt/sc/tmp-runner/p /mnt/sc/tmp-runner/p2

fifo=$SC_STICKY_FIFO
sudo install -d -o root -g root -m 1777 "$(dirname "$fifo")"
sudo mkfifo -m 0666 "$fifo"
sudo chown 65534:65534 "$fifo"
python3 -c 'import os, sys
try:
    os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_NONBLOCK, 0o666)
except PermissionError:
    sys.exit(0)
except OSError as err:
    sys.exit(f"the open gave {err}, not EACCES")
sys.exit("the open went ahead")' "$fifo" ||
	fail "an open that may create of $fifo was not refused, so fs.protected_fifos does not hold here"

v=$(/bin/zsh -fc 'print -r -- "$ZSH_VERSION $ZSH_PATCHLEVEL"' 2>&1) || true
[ "$v" = "5.9 zsh-5.9-0-g73d3173" ] || fail "/bin/zsh is '$v', not 5.9 zsh-5.9-0-g73d3173"
fp=$(/bin/zsh -fc 'print -r -- "$fpath"')
case " $fp " in *" /usr/share/zsh/5.9/functions "*) ;; *) fail "zsh's fpath is '$fp'" ;; esac
for f in history-search-end compinit _main_complete _kill; do
	[ -f "/usr/share/zsh/5.9/functions/$f" ] || fail "no /usr/share/zsh/5.9/functions/$f"
done
/bin/zsh -fc 'zmodload zsh/curses && zmodload zsh/terminfo && zmodload zsh/complist && zmodload zsh/zle' ||
	fail "zsh/curses, zsh/terminfo, zsh/complist or zsh/zle does not load"
for l in en_US.utf8 sv_SE.utf8 de_DE.utf8; do
	locale -a | grep -qx "$l" || fail "the locale $l is not generated"
done
mb=$(env LANG=en_US.UTF-8 /bin/zsh -fc 'print ${#${:-é漢}}')
[ "$mb" = 2 ] || fail "zsh in en_US.UTF-8 counts 'é漢' as '$mb' characters, not 2"
infocmp xterm-256color > /dev/null 2>&1 || fail "no terminfo entry xterm-256color"
r=$(/opt/sc-ref/bin/rsync --version | head -n 1)
case "$r" in "rsync  version 3.5.1  protocol version 33"*) ;; *) fail "the reference rsync is '$r'" ;; esac
j=$(/opt/sc-ref/bin/jj --version)
case "$j" in "jj 0.46.0"*) ;; *) fail "the reference jj is '$j'" ;; esac
b=$(/bin/bash --version | head -n 1)
echo "HOST zsh=[$v] rsync=[$r] jj=[$j] bash=[$b] locales en_US sv_SE de_DE; /mnt/sc xfs reflink; sticky FIFO $fifo refused; fs.protected_fifos=$(cat /proc/sys/fs/protected_fifos) uid=$(id -u) cpus=$(nproc) image=${ImageOS:-?}/${ImageVersion:-?} kernel=$(uname -r)"
echo "HOST / $(stat -c '%U:%G %a' /) /usr $(stat -c '%U:%G %a' /usr) /usr/bin/zsh $(stat -c '%U:%G %a' /usr/bin/zsh)"
