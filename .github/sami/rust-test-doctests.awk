# Does a crate's source hold anything rustdoc could run as a doctest? Run with
# LC_ALL=C and the crate's .rs files as arguments (rust-test.sh, run_cargo).
# On the first such thing it prints `<file>:<line>: <what>`; with none,
# `none`. It exits 0 either way, so a caller tells "no" from a scan that
# failed or read nothing only by that word.
#
# It errs on the side of yes: a crate it says no to has no doctest it could
# see, while a yes can be a crate whose doctests are all ignored. It lexes
# the source as Rust (strings, raw strings, char literals, nested block
# comments), so a doc comment is read wherever it starts on a line, and text
# in a string or a plain comment is not read as one. A yes is:
#   - in a line doc comment (/// and //!): a fenced code block whose info
#     string rustdoc may run, or an indented code block (below);
#   - any block doc comment (/** */, /*! */): rustdoc takes its `*`
#     decoration off line by line, by rules this scan does not follow;
#   - a doc attribute in any form (`doc =` after `[`, `(` or `,`: #[doc =
#     ...], #![doc = ...], cfg_attr(..., doc = ...), a macro's named doc
#     argument), literal or not: the scan does not read attribute text;
#   - include!(...), whose code the files given cannot show, and a
#     path = "..." module outside the directory (absolute, `..`, escaped)
#     or in a file that is not a .rs file, which the caller does not give.
# Not seen: a doc comment that another crate's macro (a derive, an
# attribute macro, an item macro) generates is in no source file, so the
# scan cannot see it; nor a file outside the crate's directory that its
# Cargo.toml names (rust-test.sh checks those paths). So rust-test.sh skips
# a crate on this scan only where it compares the doctests Bazel ran with
# cargo's (Linux): a doctest the scan missed that Bazel runs then fails the
# job, naming the scan. With RUST_TEST_ONLY (macOS) every crate runs.
#
# The Markdown reading follows rustdoc where it is sure and says yes where
# it is not: the indent common to an item's doc lines is not taken off
# (which can only make more lines read as indented code); a fence ends at
# its closing fence, at the end of its block quote, at a line indented less
# than the fence (a list item ending), and at the end of the item's doc
# text, the earliest of these; tabs count to the next multiple of 4.

function found(file, line, what) {
	printf "%s:%d: %s\n", file, line, what
	hit = 1
	exit 0
}

# runs(info): 0 only when rustdoc surely does not run a fenced block with
# this info string: every word is a plain lowercase word, and either one is
# a bare `ignore` (and none an ignore-<target>) or none is a Rust word. A
# word that is not plain (a quote, a brace, an attribute, a capital letter:
# rustdoc's words are case-sensitive and it unquotes them) runs, and so
# does no word at all.
function runs(info,    n, i, t, tok, ign, igt, rust, plain, words) {
	n = split(info, tok, /[ \t,]+/)
	ign = 0; igt = 0; rust = 0; plain = 1; words = 0
	for (i = 1; i <= n; i++) {
		t = tok[i]
		if (t == "") continue
		words++
		if (t == "ignore") ign = 1
		else if (t ~ /^ignore-/) igt = 1
		else if (t ~ /^(rust|should_panic|no_run|compile_fail|test_harness|standalone_crate)$/ || t ~ /^edition[0-9]+$/ || t ~ /^E[0-9][0-9][0-9][0-9]$/) rust = 1
		else if (t !~ /^[a-z][a-z0-9_+-]*$/) plain = 0
	}
	if (!plain || igt) return 1
	if (ign) return 0
	return rust || words == 0
}

# refdef(t, nx): t (one line's text, nx the next line's) as a link
# reference definition: 0 when it starts none (so it is paragraph text), 1
# when it is one that ends on its line (a closed title, or none and no title
# on the next line; a footnote definition, whose text goes on only indented),
# 2 when it may go on to later lines (no destination yet, a title not closed,
# a title on the next line, an <angle> destination): the scan does not read
# where those end.
function refdef(t, nx,    r, d) {
	if (t !~ /^\[[^]]+\]:/) return 0
	if (t ~ /^\[\^/) return 1
	r = t; sub(/^\[[^]]+\]:[ ]*/, "", r)
	if (r == "" || r ~ /^</) return 2
	d = r; sub(/[ ].*/, "", d)
	r = substr(r, length(d) + 1); sub(/^[ ]+/, "", r)
	if (r == "") { sub(/^[ >]*/, "", nx); return (nx ~ /^["'(]/) ? 2 : 1 }
	if (r ~ /^"[^"]*"[ ]*$/ || r ~ /^'[^']*'[ ]*$/ || r ~ /^[(][^)]*[)][ ]*$/) return 1
	if (r ~ /^"[^"]*$/ || r ~ /^'[^']*$/ || r ~ /^[(][^)]*$/) return 2
	return 0
}

# expand(s): s with each tab out to the next multiple of 4 columns.
function expand(s,    out, i, c) {
	if (index(s, "\t") == 0) return s
	out = ""
	for (i = 1; i <= length(s); i++) {
		c = substr(s, i, 1)
		if (c == "\t") { out = out " "; while (length(out) % 4) out = out " " }
		else out = out c
	}
	return out
}

# lead(s): leading spaces of s, or -1 for a blank line.
function lead(s,    m) {
	m = match(s, /[^ ]/)
	return m ? m - 1 : -1
}

# hold(s, kind): one line of doc text; a new kind ends the text held.
function hold(s, kind) {
	if (kind != dockind) flush()
	dockind = kind
	doc[++ndoc] = expand(s); docline[ndoc] = FNR; docfile[ndoc] = FILENAME
}

# flush(): read the doc text held as one Markdown text.
function flush(    i, r, t, d, pd, k, infence, fdepth, findent, fch, flen, run, info, prevpara, blank, m, mk, ml, odd, html, lci, hs, rd) {
	# First, is every fence of this text one the reader below is sure of?
	# Not one in a block quote, after a list marker, indented 4 or more, at
	# or past the text indent of a list item seen before it (it may be in
	# that item), or after an HTML line or a link reference definition or
	# footnote that may go on (it may be in that block, where rustdoc reads
	# no fence, so the fences after it pair otherwise). Such a fence is a
	# yes.
	html = 0; lci = -1
	for (i = 1; i <= ndoc; i++) {
		r = doc[i]
		k = lead(r)
		t = r; sub(/^ +/, "", t)
		odd = (t ~ /^>/)
		sub(/^[ >]*/, "", t)
		ml = 0
		while (match(t " ", /^([-*+]|[0-9]+[.)]) +/)) { ml += RLENGTH; t = substr(t, RLENGTH + 1); sub(/^ +/, "", t) }
		if (t ~ /^(```|~~~)/ && (odd || ml || k > 3 || html || (lci >= 0 && k >= lci))) found(docfile[i], docline[i], "a code fence in a block quote, a list item, an HTML block or deep indent, whose extent this scan does not read")
		if (ml && (lci < 0 || k + ml < lci)) lci = k + ml
		if (t ~ /^<[A-Za-z\/!?]/ || (k <= 3 && refdef(t, i < ndoc ? doc[i + 1] : "") == 2)) html = 1
	}
	infence = 0; prevpara = 0; pd = 0; hs = 0
	for (i = 1; i <= ndoc; i++) {
		r = doc[i]
		# Block quote markers: up to 3 spaces, `>`, one optional space.
		d = 0
		while (match(r, /^ ? ? ?>/)) { r = substr(r, RLENGTH + 1); if (substr(r, 1, 1) == " ") r = substr(r, 2); d++ }
		blank = (r ~ /^ *$/)
		k = lead(r)
		# A block quote that starts or ends interrupts a paragraph.
		if (d != pd) prevpara = 0
		pd = d
		if (infence) {
			if (d < fdepth || (!blank && k < findent)) infence = 0
			else {
				t = r; sub(/^ +/, "", t)
				if (substr(t, 1, flen) == run && t ~ ("^" (fch == "`" ? "`" : "~") "+ *$")) infence = 0
				prevpara = 0
				continue
			}
		}
		t = r; sub(/^ +/, "", t)
		m = 0
		while (match(t " ", /^([-*+]|[0-9]+[.)]) +/)) {
			mk = RLENGTH
			match(t, /^([-*+]|[0-9]+[.)])/); ml = RLENGTH
			# A list item whose text starts 5 or more spaces after its marker
			# starts with an indented code block.
			if (mk - ml >= 5 && substr(t, mk + 1) ~ /[^ ]/) found(docfile[i], docline[i], "an indented code block in a list item, which rustdoc runs")
			m += mk; t = substr(t, mk + 1); sub(/^ +/, "", t)
		}
		if (t ~ /^(```|~~~)/) {
			fch = substr(t, 1, 1)
			flen = match(t, fch == "`" ? "[^`]" : "[^~]")
			flen = flen ? flen - 1 : length(t)
			run = substr(t, 1, flen)
			info = substr(t, flen + 1)
			if (!(fch == "`" && index(info, "`"))) {
				infence = 1; fdepth = d; findent = (k < 0 ? 0 : k) + m
				gsub(/^ +| +$/, "", info)
				if (runs(info)) found(docfile[i], docline[i], "a code block rustdoc runs (info string \"" info "\")")
				prevpara = 0
				continue
			}
		}
		# Indented code cannot interrupt a paragraph; after anything else
		# (a blank line, a heading, a rule, a fence, the start) it starts.
		# After an HTML line, or a link reference definition or footnote that
		# may go on, the scan cannot tell where that block ends, so any line
		# indented 4 or more is a yes. A reference definition is no paragraph.
		rd = (k <= 3) ? refdef(t, i < ndoc ? doc[i + 1] : "") : 0
		if (t ~ /^<[A-Za-z\/!?]/ || rd == 2) hs = 1
		if (!blank && (!prevpara || hs) && k >= 4) found(docfile[i], docline[i], "an indented code block, which rustdoc runs")
		prevpara = !blank && !rd && t !~ /^#/ && r !~ /^ *(=+|-+) *$/ && r !~ /^ *([-*_] *)([-*_] *)([-*_] *)+$/
	}
	ndoc = 0; dockind = ""
}

# code(s): text of the source outside strings and comments (a string is
# given as "S"), checked with the last of what came before it.
function code(s,    t, p) {
	if (s ~ /[^ \t]/) flush()
	# One space for each run of blanks, and r#name as name, so a delimiter
	# stays next to the word after it however the source is laid out.
	t = " " ctail " " s
	gsub(/[ \t]+/, " ", t)
	while (match(t, /[^A-Za-z0-9_]r#[A-Za-z_]/)) t = substr(t, 1, RSTART) substr(t, RSTART + 3)
	# A space before and a \001 after stand for the start and the end, so
	# no regex here needs ^ or $ inside a group (old mawk).
	if ((t "\001") ~ /(\[|\(|,)[ \t]*doc[ \t]*=[^=]/) found(FILENAME, FNR, "a doc attribute, whose text this scan does not read")
	if ((" " t "\001") ~ /[^A-Za-z0-9_]include[ \t]*![^=]/) found(FILENAME, FNR, "include! of code this scan cannot read")
	ctail = (length(t) > 96) ? substr(t, length(t) - 95) : t
}

# Start of a string: capture it when it is a path = "..." value.
function strstart() {
	cap = (ctail ~ /(\[|\(|,)[ \t]*path[ \t]*=[ \t]*$/)
	sbuf = ""
}
function strend() {
	if (cap && (sbuf ~ /^\// || sbuf ~ /^[A-Za-z]:/ || index(sbuf, "..") || index(sbuf, "\\") || sbuf !~ /\.rs$/)) found(FILENAME, FNR, "a path = \"" sbuf "\" module that may be outside the crate's directory or its .rs files")
	cap = 0
	code("\"S\"")
}

# lexcheck(): in the file just read, every line that starts as a doc
# comment (/// or //!, after blanks) must have been read as one; one that
# was not (inside a string or a comment, as the lexer read it) is a yes,
# so a lexer mistake can only run cargo, never hide a doctest.
function lexcheck() {
	if (lfile != "" && lexdoc < naive) found(lfile, 0, "a line that looks like a doc comment, which the lexer read as part of a string or comment")
	lexdoc = 0; naive = 0; lfile = FILENAME
}

FNR == 1 { flush(); lexcheck(); st = "code"; ctail = ""; cap = 0 }

{
	line = $0; sub(/\r$/, "", line); n = length(line); i = 1
	# Rust whitespace other than space, tab and the line end (form feed,
	# vertical tab, a carriage return inside the line, NEL, LRM, RLM, the line
	# and paragraph separators) separates tokens the code and Markdown readers
	# here split only at spaces and tabs: a yes.
	if (index(line, "\r") || index(line, "\f") || index(line, "\v") || index(line, "\302\205") || index(line, "\342\200\216") || index(line, "\342\200\217") || index(line, "\342\200\250") || index(line, "\342\200\251")) found(FILENAME, FNR, "a whitespace character other than space and tab, which this scan does not read")
	if ((line " ") ~ /^[ \t]*\/\/(\/[^\/]|!)/) naive++
	while (i <= n) {
		if (st == "str") {
			p = match(substr(line, i), "[\\\\\"]")
			if (!p) { if (cap) sbuf = sbuf substr(line, i) "\n"; i = n + 1; break }
			if (cap) sbuf = sbuf substr(line, i, p - 1)
			i += p - 1
			if (substr(line, i, 1) == "\\") { if (cap) sbuf = sbuf substr(line, i, 2); i += 2; continue }
			i++; st = "code"; strend(); continue
		}
		if (st == "raw") {
			p = index(substr(line, i), "\"" rawh)
			if (!p) { if (cap) sbuf = sbuf substr(line, i) "\n"; i = n + 1; break }
			if (cap) sbuf = sbuf substr(line, i, p - 1)
			i += p + length(rawh); st = "code"; strend(); continue
		}
		if (st == "block") {
			p = match(substr(line, i), "\\*/|/\\*")
			if (!p) { i = n + 1; break }
			i += p - 1
			if (substr(line, i, 2) == "/*") { bd++; i += 2; continue }
			bd--; i += 2
			if (bd == 0) { st = "code"; code(" ") }
			continue
		}
		# Code: up to the next string, char literal or comment.
		p = match(substr(line, i), "[\"'/]")
		if (!p) { code(substr(line, i) " "); i = n + 1; break }
		seg = substr(line, i, p - 1)
		i += p - 1
		c = substr(line, i, 1)
		if (c == "\"") {
			if ((" " seg) ~ /[^A-Za-z0-9_](r|br|cr)#*$/) {
				rawh = seg; sub(/.*[^#]/, "", rawh); if (rawh == seg) rawh = ""
				sub(/(r|br|cr)#*$/, "", seg)
				code(seg)
				strstart(); st = "raw"; i++
			} else {
				code(seg)
				strstart(); st = "str"; i++
			}
			continue
		}
		code(seg)
		if (c == "'") {
			if (substr(line, i + 1, 1) == "\\") { q = index(substr(line, i + 3), "'"); i += q ? q + 3 : 2 }
			else if (substr(line, i + 2, 1) == "'") i += 3
			else { code("'"); i++ }
			continue
		}
		# c is "/"
		c2 = substr(line, i, 3)
		if (substr(line, i + 1, 1) == "/") {
			if (c2 == "///" && substr(line, i + 3, 1) != "/") hold(substr(line, i + 3), "outer")
			else if (c2 == "//!") hold(substr(line, i + 3), "inner")
			if ((c2 == "///" && substr(line, i + 3, 1) != "/" || c2 == "//!") && substr(line, 1, i - 1) ~ /^[ \t]*$/) lexdoc++
			i = n + 1
			break
		}
		if (substr(line, i + 1, 1) == "*") {
			flush()
			# A block doc comment (/** or /*!) is a yes: rustdoc takes its
			# `*` decoration off line by line, by rules this scan does not
			# follow, and that can make or unmake a fence or indented code.
			if ((c2 == "/**" && substr(line, i + 3, 1) != "*" && substr(line, i + 3, 1) != "/") || c2 == "/*!") found(FILENAME, FNR, "a block doc comment, whose decoration this scan does not read")
			st = "block"; bd = 1; i += 2
			continue
		}
		code("/"); i++
	}
	if (st == "code") code(" ")
}

END {
	if (!hit) flush()
	if (!hit) lexcheck()
	if (!hit) print "none"
}
