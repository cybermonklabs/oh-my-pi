#!/usr/bin/env bash
# Writes the rows of cp-gnu-matrix.txt.zst: runs one GNU coreutils build's cp across the probe matrix of
# `cp_does_what_gnu_does_across_the_probe_matrix` (cp.rs) and prints one tab-separated row per case: id, setup,
# arguments, standard input, exit status, standard error, standard output (each newline written as \n), and
# the entries after the run (find | sort, subdirectories included):
#   a symbolic link     name=link:target
#   a directory         name=dir#mode
#   a regular file      name=contents#links#mode#time
#   a FIFO              name=fifo#mode#time
#   a character device  name=chr#mode
# where mode is the permission bits in octal (a directory's as it was before the listing made it searchable)
# and time is 0 for a modification time of 1000000000, 2 for 2000000000 and n for any other; in a row with a
# feed: step it is - for every entry, since a FIFO's times change when the writer writes, whenever that is.
#
# The committed rows are GNU coreutils 9.7's cp on a Linux kernel, run as uid 1000 with umask 022 on a
# filesystem that cannot clone (ext4 or tmpfs; cp's defaults do not clone there):
#   TMPDIR=<scratch> bash cp-gnu-matrix.sh <coreutils-9.7/src> | zstd -19 > cp-gnu-matrix.txt.zst
# Run as root, the rows that differ from those go to cp-gnu-matrix-root.txt.zst (root can search a directory of
# mode 000 and make a device node). The `cp -R d d` rows change from run to run (GNU copies part of d into d/d
# first, in the order it reads d); cp-gnu-matrix-stated.txt states them.
#
# Two overlays hold GNU 9.7's rows where the kernel or the filesystem answers otherwise, each row prefixed with
# its family (and root's with root:); the test probes its own directory and uses a family only where the answer
# there is that family's. cp-gnu-matrix-gvisor.txt.zst holds rows measured under gVisor (families clone, link,
# mknod and rename: its kernel answers). cp-gnu-matrix-reflink.txt.zst holds the rows that differ between a run
# with TMPDIR on a filesystem that clones (XFS with reflink=1) and a run of the same build, in the same place, with
# TMPDIR on tmpfs, as uid 1000 and as root (family reflink: where `--reflink` and `--debug` copies clone), but for
# the `cp -R d d` rows, which change from run to run; where it replaces a row, a stated row without a family no
# longer applies (the `keep-data` rows: GNU's clone succeeds there).
#
# Three families of rows. The scenarios: the cases earlier rounds of review named, each with 32 modifiers and
# 12 ways of replacing a destination. The kinds: every option cp parses that GNU cp has, alone and in ordered
# pairs (so an option given after another, which may override it, is there in both orders), with each kind
# of source (a regular file, a FIFO, a character device, a symbolic link to a file, a directory) onto each
# kind of destination (none, a regular file, another link of a file, a symbolic link to the source, one to
# another file, one to nothing, one to a directory, one into a directory nobody may search, a directory). The
# named rows: cases of three options or more that review named, which the pairs do not reach.
#
# Setup steps, in order: C>name writes C to name; target@name makes a symbolic link; ln:a=b makes b another
# hard link of a; dir:d makes a directory; fifo:p makes a FIFO. Then every entry's own times are set to
# 1000000000, a step T:name=secs sets name's times (following a link) to secs, and a step mode:NNN=name sets
# name's permission bits. A step feed:p writes F into the FIFO p once cp has it open for reading, while cp
# runs. <D> in an argument is the case's directory.
#
# Usage: cp-gnu-matrix.sh <directory holding cp>
#   CPMATRIX_LIST=1 prints the row ids in order and runs nothing.
#   CPMATRIX_SHARD=k/n runs only the groups (a scenario, or a pair of source and destination kinds) whose index
#   is k modulo n (merge the shards in the CPMATRIX_LIST order).
#   CPMATRIX_ONLY=<file> runs only the rows whose ids the file lists, one per line.
set -u
BIN=${1:-}
list=${CPMATRIX_LIST:-}
shard=${CPMATRIX_SHARD:-0/1}
shard_k=${shard%/*} shard_n=${shard#*/}
declare -A only=()
if [ -n "${CPMATRIX_ONLY:-}" ]; then
	while IFS= read -r id; do only[$id]=1; done < "$CPMATRIX_ONLY"
fi
if [ -z "$list" ]; then
	[ -x "$BIN/cp" ] || { echo "usage: $0 <directory holding cp>" >&2; exit 2; }
	W=$(mktemp -d "${TMPDIR:-/tmp}/cpmatrix.XXXXXX") || exit 3
fi
# Writes F into the FIFO $1 as soon as a reader has it open, and gives up when killed.
feeder='import errno, os, sys, time
while True:
    try:
        fd = os.open(sys.argv[1], os.O_WRONLY | os.O_NONBLOCK)
    except OSError as error:
        if error.errno != errno.ENXIO:
            raise
        time.sleep(0.002)
        continue
    os.set_blocking(fd, True)
    os.write(fd, b"F")
    os.close(fd)
    break'
state() {
	local out="" f d mode t
	declare -A dmode=()
	local more=1
	while [ "$more" = 1 ]; do
		more=0
		while IFS= read -r d; do
			[ -n "${dmode[$d]+x}" ] && continue
			dmode[$d]=$(stat -c %a "$d")
			chmod u+rwx "$d" && more=1
		done < <(find . -mindepth 1 -type d 2> /dev/null)
	done
	while IFS= read -r f; do
		if [ -L "$f" ]; then out+=" ${f#./}=link:$(readlink "$f")"
		elif [ -d "$f" ]; then out+=" ${f#./}=dir#${dmode[$f]}"
		else
			mode=$(stat -c %a "$f")
			case $(stat -c %Y "$f") in 1000000000) t=0 ;; 2000000000) t=2 ;; *) t=n ;; esac
			[ -n "${feeder_pid:-}" ] && t=-
			if [ -p "$f" ]; then out+=" ${f#./}=fifo#$mode#$t"
			elif [ -S "$f" ]; then out+=" ${f#./}=sock#$mode"
			elif [ -c "$f" ]; then out+=" ${f#./}=chr#$mode"
			elif [ -b "$f" ]; then out+=" ${f#./}=blk#$mode"
			else out+=" ${f#./}=$(cat "$f")#$(stat -c %h "$f")#$mode#$t"; fi
		fi
	done < <(find . -mindepth 1 | LC_ALL=C sort)
	echo "$out"
}
escape() { # escape <file>: its exact bytes, trailing newlines kept, each newline as \n
	local text
	text=$(cat "$1"; printf x)
	text=${text%x}
	text=${text//$BIN\//}
	text=${text//$d/<D>}
	printf '%s' "${text//$'\n'/\\n}"
}
n=0
case_run() { # case_run <id> <setup> <args> <stdin>
	local id=$1 setup=$2 args=$3 input=$4 step code feeder_pid=""
	if [ -n "$list" ]; then
		echo "$id"
		return
	fi
	[ "${#only[@]}" = 0 ] || [ -n "${only[$id]+x}" ] || return
	n=$((n + 1))
	d=$W/$n
	mkdir "$d" && cd "$d" || exit 3
	umask 022
	for step in $setup; do
		case "$step" in
		T:* | mode:* | feed:*) ;;
		dir:*) mkdir "${step#dir:}" || exit 3 ;;
		fifo:*) mkfifo "${step#fifo:}" || exit 3 ;;
		sock:*) python3 -c 'import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])' "${step#sock:}" || exit 3 ;;
		ln:*) step=${step#ln:}; ln "${step%%=*}" "${step#*=}" || exit 3 ;;
		*'>'*) printf '%s' "${step%%>*}" > "${step#*>}" || exit 3 ;;
		*'@'*) ln -s "${step%%@*}" "${step#*@}" || exit 3 ;;
		*) echo "bad step $step" >&2; exit 3 ;;
		esac
	done
	find . -mindepth 1 -exec touch -h -d @1000000000 {} + || exit 3
	for step in $setup; do
		case "$step" in
		T:*) step=${step#T:}; touch -d "@${step#*=}" "${step%%=*}" || exit 3 ;;
		mode:*) step=${step#mode:}; chmod "${step%%=*}" "${step#*=}" || exit 3 ;;
		feed:*) python3 -c "$feeder" "${step#feed:}" & feeder_pid=$! ;;
		esac
	done
	local argv=()
	for a in $args; do argv+=("${a//<D>/$d}"); done
	if [ -n "$input" ]; then
		printf '%s\n' "$input" | timeout 5 "$BIN/cp" "${argv[@]}" 2> "$W/stderr.$n" > "$W/stdout.$n"
		code=${PIPESTATUS[1]}
	else
		timeout 5 "$BIN/cp" "${argv[@]}" < /dev/null 2> "$W/stderr.$n" > "$W/stdout.$n"
		code=$?
	fi
	if [ -n "$feeder_pid" ]; then
		kill "$feeder_pid" 2> /dev/null
		wait "$feeder_pid" 2> /dev/null
	fi
	printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$setup" "$args" "$input" "$code" "$(escape "$W/stderr.$n")" \
		"$(escape "$W/stdout.$n")" "$(state)"
	cd "$W" || exit 3
	rm -rf -- "$d" "$W/stderr.$n" "$W/stdout.$n"
}
group=0
in_shard() { group=$((group + 1)); [ -n "$list" ] || [ $(((group - 1) % shard_n)) = "$shard_k" ]; }

# The scenarios: id | setup | operands | the source to make newer for -u rows.
scenarios=(
	"own-same|A>a|a a|a"
	"own-same-bk|A>a old>a~|a a|a"
	"own-dot|A>a|a ./a|a"
	"own-cwd|A>a|a .|a"
	"own-abs|A>a|<D>/a a|a"
	"own-sub|dir:d A>d/a|d/a d|d/a"
	"own-sub-bk|dir:d A>d/a old>d/a~|d/a d|d/a"
	"own-sub-t|dir:d A>d/a old>d/a~|-t d d/a|d/a"
	"own-sub-abs|dir:d A>d/a old>d/a~|d/a <D>/d|d/a"
	"own-dslash|dir:d A>d/a|d//a d/a|d/a"
	"new|A>a|a b|a"
	"other|A>a B>b|a b|a"
	"hard|A>a ln:a=b|a b|a"
	"link-to-src|A>a a@l|a l|a"
	"link-to-other|A>a B>b b@l|a l|a"
	"dangling|A>a missing@l|a l|a"
	"into-dir|A>a dir:d|a d|a"
	"into-dir-ex|A>a dir:d B>d/a|a d|a"
	"src-l-same|A>a a@l|l l|a"
	"src-l-dot|A>a a@l|l ./l|a"
	"src-l-target|A>a a@l|l a|a"
	"src-l-other|A>a a@l B>b|l b|a"
	"src-l-new|A>a a@l|l b|a"
	"src-dangling|missing@l|l b|"
	"src-l-into-dir|A>a a@l dir:d|l d|a"
	"own-same-bk-link|A>a O>o o@a~|a a|a"
	"own-same-bk-dir|A>a dir:a~|a a|a"
	"three-links|A>a ln:a=b ln:a=c|a b|a"
	"dir-self|dir:d A>d/f|d d|"
	"dir-self-t|dir:d A>d/f|-t d d|"
	"hard-other|A>a B>c ln:c=b|a b|a"
	"hard-other-in-dir|A>a dir:d B>c ln:c=d/a|a d|a"
	"tree-hard-other|dir:s A>s/a dir:t dir:t/s B>c ln:c=t/s/a|s t|s/a"
)
# Flag sets: the modifiers (id | options | standard input | newer source, 1 or 0) crossed with the ways of
# replacing a destination (id | options). A modifier with -u and no newer source leaves the source as old as
# the destination, so -u skips; with a newer source -u goes on.
modifiers=(
	"|||0" "P|-P||0" "L|-L||0" "R|-R||0" "l|-l||0" "s|-s||0" "iy|-i|y|0" "in|-i|n|0" "u|-u||0" "un|-u||1"
	"u-l|-u -l||0" "un-l|-u -l||1" "u-s|-u -s||0" "un-s|-u -s||1"
	"ao|--attributes-only||0" "u-ao|-u --attributes-only||0" "un-ao|-u --attributes-only||1"
	"l-iy|-l -i|y|0" "l-in|-l -i|n|0" "u-iy|-u -i|y|0" "un-iy|-u -i|y|1" "un-in|-u -i|n|1"
	"u-l-iy|-u -l -i|y|0" "un-l-iy|-u -l -i|y|1" "un-l-in|-u -l -i|n|1"
	"u-R|-R -u||0" "un-R|-R -u||1" "a|-a||0" "d|-d||0" "pl|--preserve=links||0"
	"u-R-l|-R -u -l||0" "un-R-l|-R -u -l||1"
)
replacing=(
	"|" "f|-f" "rd|--remove-destination" "rdf|--remove-destination -f" "frd|-f --remove-destination"
	"b|-b" "fb|-f -b" "rdb|--remove-destination -b" "rdfb|--remove-destination -f -b"
	"frdb|-f --remove-destination -b" "bn|--backup=numbered" "fbn|-f --backup=numbered"
)
flagsets=()
for m in "${modifiers[@]}"; do
	IFS='|' read -r mid mflags input isnewer <<< "$m"
	for r in "${replacing[@]}"; do
		IFS='|' read -r rid rflags <<< "$r"
		id=$mid${mid:+${rid:+-}}$rid
		flags=$mflags${mflags:+${rflags:+ }}$rflags
		flagsets+=("${id:-plain}|$flags|$input|$isnewer")
	done
done
for s in "${scenarios[@]}"; do
	in_shard || continue
	IFS='|' read -r sid setup operands newer <<< "$s"
	for f in "${flagsets[@]}"; do
		IFS='|' read -r fid flags input isnewer <<< "$f"
		steps=$setup
		if [ "$isnewer" = 1 ]; then
			[ -n "$newer" ] || continue
			steps+=" T:$newer=2000000000"
		fi
		case_run "$sid/$fid" "$steps" "${flags:+$flags }$operands" "$input"
	done
done

# The kinds. Sources: id | setup | operand. Destinations: id | setup, where SRC stands for the source operand.
sources=(
	"reg|A>a|a"
	"fifo|fifo:p feed:p|p"
	"chr||/dev/null"
	"lnk|A>a a@l|l"
	"dir|dir:s A>s/f|s"
)
destinations=(
	"none|"
	"reg|B>b"
	"hard|B>c ln:c=b"
	"tosrc|SRC@b"
	"toother|B>c c@b"
	"dangling|none@b"
	"todir|dir:e B>e/x e@b"
	"unsearchable|dir:u B>u/x u/x@b mode:000=u"
	"dir|dir:b"
)
# Every option cp parses that GNU cp has (id | arguments | standard input). -t b takes the destination's
# place. Left out: -c and -g (pi's own, which GNU cp refuses), --help and --version.
options=(
	"a|-a|" "ao|--attributes-only|" "b|-b|" "bk|--backup|" "bkn|--backup=numbered|" "bks|--backup=simple|"
	"bke|--backup=existing|" "bko|--backup=none|" "cc|--copy-contents|" "d|-d|" "dbg|--debug|" "f|-f|"
	"iy|-i|y" "in|-i|n" "H|-H|" "l|-l|" "L|-L|" "n|-n|" "P|-P|" "p|-p|"
	"pr|--preserve|" "pra|--preserve=all|" "prl|--preserve=links|" "prm|--preserve=mode|"
	"pro|--preserve=ownership|" "prt|--preserve=timestamps|" "npa|--no-preserve=all|" "npm|--no-preserve=mode|"
	"npl|--no-preserve=links|" "npt|--no-preserve=timestamps|" "par|--parents|" "R|-R|"
	"rf|--reflink|" "rfn|--reflink=never|" "rfa|--reflink=auto|" "rd|--remove-destination|"
	"spa|--sparse=always|" "spn|--sparse=never|" "spu|--sparse=auto|" "sts|--strip-trailing-slashes|"
	"s|-s|" "S|-S .bak|" "t|-t b|" "T|-T|" "u|-u|" "ua|--update=all|" "un|--update=none|" "uo|--update=older|"
	"unf|--update=none-fail|" "v|-v|" "x|-x|" "Z|-Z|" "ctx|--context|"
)
optsets=("plain|||")
for o in "${options[@]}"; do
	IFS='|' read -r oid oargs oin <<< "$o"
	optsets+=("$oid|$oargs|$oin|$oid")
done
for o1 in "${options[@]}"; do
	IFS='|' read -r id1 args1 in1 <<< "$o1"
	for o2 in "${options[@]}"; do
		IFS='|' read -r id2 args2 in2 <<< "$o2"
		[ "$id1" = "$id2" ] && continue
		# Two answers for one question: -i y with -i n.
		[ -n "$in1" ] && [ -n "$in2" ] && continue
		optsets+=("$id1+$id2|$args1 $args2|$in1$in2|$id1 $id2")
	done
done
for s in "${sources[@]}"; do
	IFS='|' read -r sid ssetup sop <<< "$s"
	for t in "${destinations[@]}"; do
		in_shard || continue
		IFS='|' read -r tid tsetup <<< "$t"
		setup="$ssetup${ssetup:+${tsetup:+ }}${tsetup//SRC/$sop}"
		for o in "${optsets[@]}"; do
			IFS='|' read -r oid oargs oin oids <<< "$o"
			case " $oids " in
			*" t "*) operands=$sop ;;
			*) operands="$sop b" ;;
			esac
			case_run "k/$sid-$tid/$oid" "$setup" "${oargs:+$oargs }$operands" "$oin"
		done
	done
done

# The named rows: id | setup | arguments | standard input.
named=(
	"x/P-ao-rd|A>a a@s B>b|-P --attributes-only --remove-destination s b|"
	"x/ao-fb-dangling|A>a none@a~|--attributes-only -f -b a a|"
	"x/ao-fb-dir-link|A>a dir:d d@a~|--attributes-only -f -b a a|"
	"x/ao-fb-unsearchable|A>a dir:u B>u/x u/x@a~ mode:000=u|--attributes-only -f -b a a|"
	"x/rd-i-fb-self-loop-n|A>a a~@a~|--remove-destination -i -f -b a a|n"
	"x/rd-i-fb-self-loop-y|A>a a~@a~|--remove-destination -i -f -b a a|y"
	"x/a-b-null|B>b|-a -b /dev/null b|"
	"x/a-b-fifo|fifo:p B>b|-a -b p b|"
	"x/ao-P-b|A>a a@l B>b|--attributes-only -P -b l b|"
)
# A backup name that is another link of the destination's own file: the rename that makes the backup does
# nothing on Linux, and the create then meets the name.
for row in "copy||a" "f|-f|a" "i|-i|a|y" "v|-v|a" "rd|--remove-destination|a" "l|-l|a" "lf|-l -f|a" "li|-l -i|a|y" \
	"s|-s|a" "sf|-s -f|a" "P|-P|l" "Pf|-P -f|l" "Pi|-P -i|l|y" "Pv|-P -v|l"; do
	IFS='|' read -r rid rflags rsrc rin <<< "$row"
	named+=("x/hl-bk-$rid|A>a a@l old>b ln:b=b~|${rflags:+$rflags }-b $rsrc b|$rin")
done
# A copied link onto a FIFO or a socket, and a backup the source leads to (a copy backup).
for kind in "fifo|fifo:b" "sock|sock:b"; do
	IFS='|' read -r kid ksetup <<< "$kind"
	for row in "P|-P" "R|-R" "d|-d" "Pf|-P -f" "Pv|-P -v" "Pfv|-P -f -v" "Prdv|-P --remove-destination -v"; do
		IFS='|' read -r rid rflags <<< "$row"
		named+=("x/lnk-onto-$kid-$rid|A>a a@l $ksetup|$rflags l b|")
	done
done
# The backup name another link of the destination's file, which is the source's own file too, or which a FIFO
# or --attributes-only meets.
for row in "b|-b" "simple|--backup=simple" "existing|--backup=existing" "fb|-fb"; do
	IFS='|' read -r rid rflags <<< "$row"
	named+=("x/hl3-bk-$rid|A>a ln:a=dest ln:a=dest~|$rflags a dest|")
done
named+=("x/hl-bk-ao|A>a a@l old>b ln:b=b~|--attributes-only -b a b|")
named+=("x/hl-fifo-Rb|fifo:p old>b ln:b=b~|-R -b p b|")
named+=("x/hl-fifo-Rfb|fifo:p old>b ln:b=b~|-R -fb p b|")
for row in "Pfb|-P -f -b" "Pb|-P -b" "Rb|-R -b" "Prdb|-P --remove-destination -b"; do
	IFS='|' read -r rid rflags <<< "$row"
	named+=("x/copy-bk-$rid|A>a a@l|$rflags l a|")
done
# A numbered backup where an older numbered backup is another link of the destination's own file.
for row in "n|--backup=numbered|a" "fn|-f --backup=numbered|a" "Pfn|-P -f --backup=numbered|l" "e|--backup=existing|a" \
	"fe|-f --backup=existing|a"; do
	IFS='|' read -r rid rflags rsrc <<< "$row"
	named+=("x/hln-bk-$rid|A>a a@l old>b ln:b=b.~1~|$rflags $rsrc b|")
done
if in_shard; then
	for row in "${named[@]}"; do
		IFS='|' read -r nid nsetup nargs nin <<< "$row"
		case_run "$nid" "$nsetup" "$nargs" "$nin"
	done
fi
[ -n "$list" ] || { cd / && rm -rf -- "$W"; }
