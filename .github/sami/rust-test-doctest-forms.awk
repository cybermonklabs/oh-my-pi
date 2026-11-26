# The doctests of a crate, read from its source with no build (rust-test.sh,
# the Linux job, where the doctests run only in Bazel's rust_doc_test
# targets, whose runner shows no passing doctest's output). Run with
# LC_ALL=C, -v words='<the skip scan's marker words, an ERE alternation>',
# and the crate's .rs files as arguments. It prints, tab-separated:
#   test <file> <line>            each code block rustdoc lists as a doctest
#                                 it runs or compiles, by the line of its
#                                 opening fence (of its first line, for an
#                                 indented block): rustdoc names a doctest
#                                 `<file> - <item> (line <line>)`
#   print <file> <line> <text>    a line of a doctest rustdoc runs that holds
#                                 the word print, println, eprint, eprintln,
#                                 dbg, stdout or stderr
#   skip <file> <line> <text>     a line of a doctest rustdoc runs that holds
#                                 one of the skip scan's words
#   unread <file> <line> <what>   doc text whose doctests it does not read
#
# The doc text of an item (or, for //! and /*!, of a module) is every doc
# comment and doc attribute before it: /// lines, /** */ comments and
# #[doc = ...], or //! lines, /*! */ comments and #![doc = ...], with blank
# lines, other attributes and plain comments between them, as rustdoc joins
# them. A block doc comment's nested /* */ are its text. Its lines are read
# twice, with their leading `*` (rustdoc keeps it unless every line has it)
# and without it, and either reading's finding counts. A doc attribute's
# one-line string literal is doc text (\n, \t, \\, \" and \' decoded); any
# other value (include_str!, concat!, a macro's $variable, a literal over
# lines or with another escape), or a second doc attribute on its line, is
# `unread`.
# In the doc text, a fenced block (``` or ~~~, after any indent, `>` or list
# marker) is a doctest unless its info string names only plain lowercase
# words none of which is a Rust one (text, sh, toml: not Rust to rustdoc),
# or has a bare `ignore` (rustdoc lists it as ignored and runs nothing).
# no_run and compile_fail make a doctest that is compiled and not run; its
# lines are read all the same. A Rust block ends only at a closing fence
# CommonMark takes (at its own block quote depth, at most 3 spaces in, no
# list marker); any other block, at any fence-like line. An
# indented code block (4 columns past
# the text's least indent, after a blank line, a heading or a fence) is a
# doctest too. Hidden lines (`# ...`) are code, and are read. A runnable
# block still open where the item's doc text ends is `unread`: the reader
# may have split one item's text.
# Where it is unsure, it reads more: a word, not a macro call, is a print
# (so `println` split from its `!` by a comment or a line counts), and an
# over-read can only fail the job, where an under-read would hide a doctest;
# rust-test.sh checks that every doctest Bazel ran is a `test` here.

function kind(info,    n, i, t, tok, ign, igt, nr, rust, plain, words) {
	gsub(/[{}]/, " ", info)
	n = split(info, tok, /[ \t,]+/)
	ign = 0; igt = 0; nr = 0; rust = 0; plain = 1; words = 0
	for (i = 1; i <= n; i++) {
		t = tok[i]
		if (t == "") continue
		words++
		if (t == "ignore") { ign = 1; rust = 1 }
		else if (t ~ /^ignore-/) { igt = 1; rust = 1 }
		else if (t == "no_run" || t == "compile_fail") { nr = 1; rust = 1 }
		else if (t ~ /^(rust|should_panic|test_harness|standalone_crate)$/ || t ~ /^edition[0-9]+$/ || t ~ /^E[0-9][0-9][0-9][0-9]$/) rust = 1
		else if (t !~ /^[a-z][a-z0-9_+-]*$/) plain = 0
	}
	if (!plain || igt) return nr ? "build" : "run"
	if (words && !rust) return "none"
	if (ign) return "ignore"
	if (nr) return "build"
	return "run"
}

# lead(s): the leading spaces of s (tabs to the next multiple of 4), or -1
# for a blank line.
function lead(s,    i, c, k) {
	k = 0
	for (i = 1; i <= length(s); i++) {
		c = substr(s, i, 1)
		if (c == " ") k++
		else if (c == "\t") k += 4 - k % 4
		else return k
	}
	return -1
}

# forms(file, line, s): one code line of a doctest rustdoc runs.
function forms(file, line, s,    t, w) {
	t = s
	sub(/^[ \t]+/, "", t)
	t = substr(t, 1, 120)
	w = " " s " "
	if (w ~ /[^A-Za-z0-9_](print|println|eprint|eprintln|dbg|stdout|stderr)[^A-Za-z0-9_]/) out("print", file, line, t)
	if (w ~ ("[^A-Za-z0-9_](" words ")[^A-Za-z0-9_]")) out("skip", file, line, t)
}

# out(...): one finding, once.
function out(what, file, line, t,    key) {
	key = what SUBSEP file SUBSEP line
	if (key in said) return
	said[key] = 1
	if (what == "test") printf "test\t%s\t%d\n", file, line
	else printf "%s\t%s\t%d\t%s\n", what, file, line, t
}

# hold(s, k, star): one line of doc text of kind k (outer, inner); star is 1
# for a block doc comment's line, whose leading `*` the second reading takes
# off. Text of the other kind ends the text held.
function hold(s, k, star) {
	if (k != dockind) flush()
	dockind = k
	ndoc++
	doc[ndoc] = s; docstar[ndoc] = star; docline[ndoc] = FNR; docfile[ndoc] = FILENAME
}

# flush(): read the doc text held, as written and with block lines' stars off.
function flush(    i) {
	if (ndoc == 0) { dockind = ""; return }
	for (i = 1; i <= ndoc; i++) text[i] = doc[i]
	readtext(1)
	for (i = 1; i <= ndoc; i++) {
		text[i] = doc[i]
		if (docstar[i]) sub(/^[ \t]*\*/, "", text[i])
	}
	readtext(0)
	ndoc = 0; dockind = ""
}

# quotes(r): the number of `>` block quote markers before r's text.
function quotes(r,    pre) {
	match(r, /^[ \t>]*/)
	pre = substr(r, 1, RLENGTH)
	return gsub(/>/, ">", pre)
}

# closes(r, base, oq, fch, run): r closes a Rust block opened at block quote
# depth oq with the fence run: past the text's indent (base) and oq quote
# markers, at most 3 spaces, then a fence of the same character at least as
# long, and nothing else. A line with a list marker, 4 or more spaces, a tab
# or another depth is the block's code.
function closes(r, base, oq, fch, run,    rr, k, q) {
	rr = r
	k = 0
	while (k < base && substr(rr, 1, 1) == " ") { rr = substr(rr, 2); k++ }
	q = 0
	while (match(rr, /^ ? ? ?>/)) {
		rr = substr(rr, RLENGTH + 1)
		if (substr(rr, 1, 1) == " ") rr = substr(rr, 2)
		q++
	}
	if (q != oq || rr ~ /^ ? ? ?\t/) return 0
	k = lead(rr)
	if (k < 0 || k > 3) return 0
	rr = substr(rr, k + 1)
	return substr(rr, 1, length(run)) == run && rr ~ ("^" (fch == "`" ? "`" : "~") "+[ \t]*$")
}

# readtext(first): read text[1..ndoc] as one Markdown text. A Rust block
# (one rustdoc runs or compiles) ends only at a line closes() takes as its
# closing fence, so a fence-like line in it (in a string, say) is read as
# its code; any other block ends at any fence-like line, so what follows is
# read as text. Both read more where they guess. The lines of a block
# rustdoc compiles and does not run are read too: its info string may say
# no_run in a comment or a class rustdoc reads as such.
function readtext(first,    i, r, t, k, base, infence, fch, flen, run, info, kd, prevopen, code, blank, open, oq) {
	base = -1
	for (i = 1; i <= ndoc; i++) {
		k = lead(text[i])
		if (k >= 0 && (base < 0 || k < base)) base = k
	}
	if (base < 0) base = 0
	infence = 0; prevopen = 1; code = 0
	for (i = 1; i <= ndoc; i++) {
		r = text[i]
		t = r
		sub(/^[ \t>]*/, "", t)
		while (match(t " ", /^([-*+]|[0-9]+[.)])[ \t]+/)) { t = substr(t, RLENGTH + 1); sub(/^[ \t]+/, "", t) }
		if (infence) {
			if ((kd == "run" || kd == "build") ? closes(r, base, oq, fch, run) : (substr(t, 1, flen) == run && t ~ ("^" (fch == "`" ? "`" : "~") "+[ \t]*$"))) { infence = 0; prevopen = 1; continue }
			if (kd == "run" || kd == "build") forms(docfile[i], docline[i], r)
			continue
		}
		if (t ~ /^(```|~~~)/) {
			fch = substr(t, 1, 1)
			flen = match(t, fch == "`" ? "[^`]" : "[^~]")
			flen = flen ? flen - 1 : length(t)
			run = substr(t, 1, flen)
			info = substr(t, flen + 1)
			if (!(fch == "`" && index(info, "`"))) {
				infence = 1; code = 0; open = i; oq = quotes(r)
				kd = kind(info)
				if (kd == "run" || kd == "build") out("test", docfile[i], docline[i])
				continue
			}
		}
		k = lead(r)
		blank = (k < 0)
		if (!blank && k >= base + 4 && (prevopen || code)) {
			if (!code) out("test", docfile[i], docline[i])
			code = 1
			forms(docfile[i], docline[i], r)
			continue
		}
		if (!blank) code = 0
		# Indented code starts after a blank line or a heading, never inside
		# a paragraph.
		prevopen = blank || t ~ /^#/
	}
	if (infence && (kd == "run" || kd == "build") && first) out("unread", docfile[open], docline[open], "a doctest still open where the doc text the reader joined ends, so it may have split an item's doc text")
}

# literal(s): the decoded text of the string literal at the start of s (its
# opening quote included), or the empty string with bad set when it does not
# end on this line or holds an escape not decoded here.
function literal(s,    i, c, v, n) {
	bad = 1
	if (substr(s, 1, 1) != "\"") return ""
	v = ""
	n = length(s)
	for (i = 2; i <= n; i++) {
		c = substr(s, i, 1)
		if (c == "\"") { bad = 0; return v }
		if (c == "\\") {
			c = substr(s, i + 1, 1)
			i++
			if (c == "n") v = v "\n"
			else if (c == "t") v = v "\t"
			else if (c == "\\" || c == "\"" || c == "'") v = v c
			else return ""
		} else v = v c
	}
	return ""
}

FNR == 1 { flush(); inblock = 0; plain = 0 }

# Inside a /** or /*! comment (depth counts nested /* */).
inblock {
	s = $0; rest = s; pos = 0; cut = 0
	while (match(rest, /\/\*|\*\//)) {
		pos += RSTART
		if (substr(rest, RSTART, 2) == "/*") depth++
		else if (--depth == 0) { cut = pos; break }
		pos += 1
		rest = substr(rest, RSTART + 2)
	}
	if (cut) s = substr(s, 1, cut - 1)
	hold(s, blockkind, 1)
	if (cut) inblock = 0
	next
}

# Inside a plain /* comment: no text, and no end of the doc text.
plain {
	rest = $0
	while (match(rest, /\/\*|\*\//)) {
		if (substr(rest, RSTART, 2) == "/*") plain++
		else if (--plain == 0) break
		rest = substr(rest, RSTART + 2)
	}
	next
}

/^[ \t]*\/\/\/([^\/]|$)/ || /^[ \t]*\/\/!/ {
	s = $0
	k = (s ~ /^[ \t]*\/\/!/) ? "inner" : "outer"
	sub(/^[ \t]*\/\/[\/!]/, "", s)
	hold(s, k, 0)
	next
}

/^[ \t]*\/\*[*!]/ && !/^[ \t]*\/\*\*\*/ && !/^[ \t]*\/\*\*\// {
	blockkind = ($0 ~ /^[ \t]*\/\*!/) ? "inner" : "outer"
	s = $0
	sub(/^[ \t]*\/\*[*!]/, "", s)
	rest = s; pos = 0; cut = 0; depth = 1
	while (match(rest, /\/\*|\*\//)) {
		pos += RSTART
		if (substr(rest, RSTART, 2) == "/*") depth++
		else if (--depth == 0) { cut = pos; break }
		pos += 1
		rest = substr(rest, RSTART + 2)
	}
	if (cut) s = substr(s, 1, cut - 1)
	hold(s, blockkind, 1)
	if (!cut) inblock = 1
	next
}

# A doc attribute: a line with `#` and the word doc. A line with /* or */ on
# it (a comment between tokens, or one in a string: this reader does not
# tell them apart), with the word doc more than once (another attribute,
# split or not, may be beside it), or with a doc at its end or before a //
# comment (its `=` may follow on the next line), is unread; one `doc =` with
# a one-line string literal is doc text; any other value is unread. Only a
# lone doc followed by `(`, `)`, `]` or `,` (#[doc(hidden)], #[cfg(doc)])
# carries no doc text; any other use of the word (r#doc =, say) is unread.
$0 ~ /#[ \t]*!?[ \t]*\[/ && (" " $0 " ") ~ /[^A-Za-z0-9_]doc[^A-Za-z0-9_]/ {
	s = $0
	nd = 0
	m = split(s, tok, /[^A-Za-z0-9_]+/)
	for (j = 1; j <= m; j++) if (tok[j] == "doc") nd++
	t = " " s
	n = gsub(/[\[(,][ \t]*doc[ \t]*=/, "&", t)
	if (nd == 1 && n == 0 && (" " s) ~ /[^A-Za-z0-9_#]doc[ \t]*[](),]/ && !index(s, "/*") && !index(s, "*/")) {
		# No doc text here; an attribute or code line as any other.
		if ($0 ~ /^[ \t]*#!?[ \t]*\[/) next
		flush()
		next
	}
	if (nd != 1 || n != 1 || index(s, "/*") || index(s, "*/")) {
		flush()
		out("unread", FILENAME, FNR, "a doc attribute this reader does not read (a /* or */ on its line, the word doc more than once, or `doc` and `=` apart)")
		next
	}
	sub(/.*[\[(,][ \t]*doc[ \t]*=[ \t]*/, "", s)
	k = (" " $0) ~ /#![ \t]*\[/ ? "inner" : "outer"
	v = literal(s)
	if (!bad) {
		n = split(v, part, /\n/)
		for (j = 1; j <= n; j++) hold(part[j], k, 0)
		next
	}
	flush()
	out("unread", FILENAME, FNR, "a doc attribute whose value is not a one-line string literal with only \\n, \\t, \\\\, \\\" or \\' escapes")
	next
}

# What does not end an item's doc text: a blank line, an attribute, a plain
# comment (a /* one runs to its end).
/^[ \t]*$/ || /^[ \t]*#!?[ \t]*\[/ || /^[ \t]*\/\/([^\/!]|\/\/|$)/ { next }
/^[ \t]*\/\*/ {
	rest = $0; plain = 0
	while (match(rest, /\/\*|\*\//)) {
		if (substr(rest, RSTART, 2) == "/*") plain++
		else if (--plain == 0) break
		rest = substr(rest, RSTART + 2)
	}
	next
}

{ flush() }

END { flush() }
