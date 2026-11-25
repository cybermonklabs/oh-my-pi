//! bash's dynamic variables as bash code sees them.
//!
//! bash keeps `RANDOM` and `SECONDS` in its variable table like any other
//! variable, with a value function (`get_random`, `get_seconds`) and an
//! assignment function (`assign_random`, `assign_seconds`). Every lookup of
//! the name (`find_variable`) runs the value function, which computes a new
//! value and stores it as the variable's, with the integer attribute: a
//! `RANDOM` lookup draws a number. So does every builtin, assignment and
//! expansion that looks the name up, as many times as it looks it up:
//! `declare -i RANDOM` draws twice, `${RANDOM:0}` three times. [`Site`]
//! is the table of those counts, measured against bash 5.3.20.
//!
//! `unset`, a local or temporary of the name, and an element, compound or
//! array-attribute assignment (`convert_var_to_array`) make it a plain
//! variable: [`Kernel::plain`] for the first and the last (for good, in
//! every child too), the scope for a local or a temporary.
//!
//! [`LISTED`] is the table of the names `${!prefix*}`, `${!prefix@}` and
//! `compgen -v` list for bash's dynamic variables, which this shell computes
//! on use and keeps no variable for.

use std::fmt::NumBuffer;

use bstr::BString;

use super::{
	Cx, Kernel,
	proc::Vproc,
	state::{self, Level, Var},
};
use crate::bash::{
	ids::Dialect,
	store::{Attrs, StateStore, StoreError, VarValue},
};

/// A dynamic variable whose special meaning bash code can remove, with the
/// state the kernel keeps for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Special {
	/// `RANDOM`: the generator (`Kernel::rand`, `proc::Clock::rand`).
	Random,
	/// `SECONDS`: the clock (`Kernel::start_ns`, `proc::Clock::start_ns`).
	Seconds,
}

impl Special {
	/// The special variable `name` is, if any.
	#[inline]
	pub const fn of(name: &[u8]) -> Option<Self> {
		match name {
			b"RANDOM" => Some(Self::Random),
			b"SECONDS" => Some(Self::Seconds),
			_ => None,
		}
	}

	/// Its name.
	pub const fn name(self) -> &'static [u8] {
		match self {
			Self::Random => b"RANDOM",
			Self::Seconds => b"SECONDS",
		}
	}

	/// The attributes the variable has before bash code gives it others:
	/// bash's `RANDOM` is integer from the start (`initialize_dynamic_
	/// variables`), `SECONDS` once it is looked up.
	const fn attrs(self) -> Attrs {
		match self {
			Self::Random => Attrs::INTEGER,
			Self::Seconds => Attrs::NONE,
		}
	}
}

/// The special variable `name` is as `vp`'s bash code sees it: bash code,
/// the special meaning not removed ([`Kernel::plain`]) and no local or
/// temporary of the name in scope (bash makes those plain variables:
/// `make_local_variable` and `assign_in_env` copy no value function).
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
#[inline]
pub fn visible(
	k: &Kernel,
	store: &mut dyn StateStore,
	vp: &Vproc,
	name: &[u8],
) -> Result<Option<Special>, StoreError> {
	let Some(s) = Special::of(name) else {
		return Ok(None);
	};
	if vp.mode.dialect() != Dialect::Bash || k.plain(vp, s) {
		return Ok(None);
	}
	Ok(state::lookup_declared_scoped(&k.root, store, vp, name)?
		.1
		.is_none()
		.then_some(s))
}

/// One lookup of `s` (bash's `find_variable` running `get_random` or
/// `get_seconds`): the new value, which the variable keeps as its value,
/// with the integer attribute set (`set_int_value` with flag 1), as the
/// text a later `+=` adds to and the value `declare -p`, `set` and the
/// environment show.
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn lookup(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	s: Special,
) -> Result<i64, StoreError> {
	let value = match s {
		Special::Random => i64::from(k.next_random(cx, vp)),
		Special::Seconds => k.seconds_now(vp, cx.host.now_ns()),
	};
	store_value(k, cx.store, vp, s, value, true)?;
	Ok(value)
}

/// The special variable's value becomes `value` (bash's `set_int_value`):
/// its attributes kept, the integer one added when `integer`. Not while the
/// redirections of a command bash runs in a child are expanded
/// ([`Kernel::redirs_in_child`]): the cell that changes is the child's.
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn store_value(
	k: &mut Kernel,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	s: Special,
	value: i64,
	integer: bool,
) -> Result<(), StoreError> {
	if k.redirs_in_child {
		return Ok(());
	}
	let name = s.name();
	let mut buf = NumBuffer::new();
	let text = value.format_into(&mut buf).as_bytes();
	let var = state::global_in(store, vp, name)?;
	// `$SECONDS` read twice in a second stores nothing the second time.
	if var.is_some_and(|v| {
		(!integer || v.attrs.contains(Attrs::INTEGER))
			&& !v.attrs.contains(Attrs::INVISIBLE)
			&& matches!(&v.value, VarValue::Str(s) if s == text)
	}) {
		return Ok(());
	}
	let attrs = var
		.map_or_else(|| s.attrs(), |v| v.attrs)
		.without(Attrs::INVISIBLE);
	let attrs = if integer {
		attrs.with(Attrs::INTEGER)
	} else {
		attrs
	};
	let var = Var { attrs, value: VarValue::Str(BString::from(text)) };
	state::store_var(&mut k.root, store, vp, name, Some(var), Level::Global);
	Ok(())
}

/// bash's dynamic variables with a value cell besides `RANDOM` and
/// `SECONDS` (bash 5.3.20's `initialize_dynamic_variables`), with the
/// attributes bash gives them. A lookup runs the value function, which
/// keeps its result as the variable's value ([`keep_cell`]); `declare -p`
/// and `set` list that value. Before the first lookup `declare -p` lists a
/// scalar with its attributes alone and `set` does not list it; an array is
/// listed empty.
pub const CELLS: &[(&[u8], Attrs)] = &[
	(b"BASHPID", Attrs::INTEGER),
	(b"BASH_ALIASES", Attrs::ASSOC),
	(b"BASH_CMDS", Attrs::ASSOC),
	(b"BASH_COMMAND", Attrs::NONE),
	(b"BASH_SUBSHELL", Attrs::NONE),
	(b"DIRSTACK", Attrs::INDEXED),
	(b"EPOCHREALTIME", Attrs::NONE),
	(b"EPOCHSECONDS", Attrs::NONE),
	(b"LINENO", Attrs::NONE),
	(b"SRANDOM", Attrs::INTEGER),
];

/// bash's attributes of the value-cell variable `name` ([`CELLS`]).
pub fn cell_attrs(name: &[u8]) -> Option<Attrs> {
	CELLS.iter().find(|(n, _)| *n == name).map(|&(_, a)| a)
}

/// The position of the value-cell variable `name` in [`CELLS`] (its bit in
/// `Kernel::cells_plain`).
pub fn cell_index(name: &[u8]) -> Option<usize> {
	CELLS.iter().position(|(n, _)| *n == name)
}

/// Keep `value`, what a lookup of the value-cell variable `name` computed,
/// as its value (a global record, the attributes it has kept). An empty
/// associative array is kept as bash's value functions leave it
/// (`build_hashcmd`, `build_aliasvar`: no value): `declare -p` lists it as
/// `()`, `set` not at all ([`Attrs::INVISIBLE`]). Bash code only; not while
/// a subshell's redirections are expanded (the cell is the child's).
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn keep_cell(
	k: &mut Kernel,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	name: &[u8],
	value: VarValue,
) -> Result<(), StoreError> {
	let Some(base) = cell_attrs(name) else {
		return Ok(());
	};
	if vp.mode.dialect() != Dialect::Bash || k.redirs_in_child {
		return Ok(());
	}
	let unset = matches!(&value, VarValue::Assoc(a) if a.is_empty());
	let var = state::global_in(store, vp, name)?;
	// bash's value functions for `SRANDOM` and `BASHPID` set the integer
	// attribute again each time they run, so a lookup after `declare +i
	// SRANDOM` lists `declare -i SRANDOM` again.
	let attrs = var.map_or(base, |v| v.attrs);
	let attrs = if base.contains(Attrs::INTEGER) {
		attrs.with(Attrs::INTEGER)
	} else {
		attrs
	};
	let attrs = if unset {
		attrs.with(Attrs::INVISIBLE)
	} else {
		attrs.without(Attrs::INVISIBLE)
	};
	if var.is_some_and(|v| v.attrs == attrs && v.value == value) {
		return Ok(());
	}
	state::store_var(&mut k.root, store, vp, name, Some(Var { attrs, value }), Level::Global);
	Ok(())
}

/// The variables `declare -p` and `set` list for bash's value cells that
/// hold no value of their own yet, added to `vars` (sorted after): with
/// `declared` (`declare -p`), a scalar of [`CELLS`] and a special `RANDOM`
/// or `SECONDS` never looked up, by their attributes alone; the arrays
/// empty; `PIPESTATUS` once a command's status is recorded (bash sets it
/// then); an associative cell a lookup left empty as `()`. Bash code only.
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn with_cells(
	k: &Kernel,
	store: &mut dyn StateStore,
	vp: &Vproc,
	vars: &mut Vec<(BString, Var)>,
	declared: bool,
) -> Result<(), StoreError> {
	if vp.mode.dialect() != Dialect::Bash {
		return Ok(());
	}
	if declared {
		for (name, var) in vars.iter_mut() {
			if matches!(name.as_slice(), b"BASH_ALIASES" | b"BASH_CMDS")
				&& var.attrs.contains(Attrs::INVISIBLE)
				&& matches!(&var.value, VarValue::Assoc(a) if a.is_empty())
			{
				var.attrs = var.attrs.without(Attrs::INVISIBLE);
			}
		}
	}
	let random = visible(k, store, vp, b"RANDOM")?.is_some();
	let seconds = visible(k, store, vp, b"SECONDS")?.is_some();
	let specials = [(&b"RANDOM"[..], Attrs::INTEGER, random), (b"SECONDS", Attrs::NONE, seconds)];
	// A cell `unset` removed is a plain variable: listed as one when it has
	// a value, not at all otherwise.
	let cells = CELLS
		.iter()
		.enumerate()
		.map(|(i, &(name, attrs))| (name, attrs, !k.cell_plain(vp, i)));
	for (name, attrs, shown) in cells.chain(specials) {
		// A kept cell is listed as stored (`set` leaves out an invisible
		// one), even when this listing's scan left it out.
		if !shown
			|| vars.iter().any(|(n, _)| n.as_slice() == name)
			|| state::global_in(store, vp, name)?.is_some()
		{
			continue;
		}
		let var = if attrs.contains(Attrs::ASSOC) {
			Var { attrs, value: VarValue::Assoc(Default::default()) }
		} else if attrs.contains(Attrs::INDEXED) {
			Var { attrs, value: VarValue::Indexed(Vec::new()) }
		} else if declared {
			Var { attrs: attrs.with(Attrs::INVISIBLE), value: VarValue::Str(BString::default()) }
		} else {
			continue;
		};
		vars.push((BString::from(name), var));
	}
	if !vp.pipestatus.is_empty() && !vars.iter().any(|(n, _)| n.as_slice() == b"PIPESTATUS") {
		let mut buf = NumBuffer::new();
		let items = vp
			.pipestatus
			.iter()
			.zip(0i64..)
			.map(|(s, i)| (i, BString::from(s.format_into(&mut buf))))
			.collect();
		vars.push((BString::from("PIPESTATUS"), Var {
			attrs: Attrs::INDEXED,
			value: VarValue::Indexed(items),
		}));
	}
	Ok(())
}

/// The lookups bash 5.3.20 makes of `name` at `site` when `name` is a
/// special variable `vp`'s bash code sees; none for any other name.
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn look(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	name: &[u8],
	site: Site,
) -> Result<(), StoreError> {
	let n = site.lookups();
	if n == 0 {
		return Ok(());
	}
	if let Some(s) = visible(k, cx.store, vp, name)? {
		for _ in 0..n {
			lookup(k, cx, vp, s)?;
		}
	}
	Ok(())
}

/// The special variable bash code's `name` is, or the one a name reference
/// `name` names (whole: `declare -n r=RANDOM`), by name only: whether it
/// is special now is [`visible`]'s answer. `None` in zsh mode.
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn named(
	k: &Kernel,
	store: &mut dyn StateStore,
	vp: &Vproc,
	name: &[u8],
) -> Result<Option<Special>, StoreError> {
	if vp.mode.dialect() != Dialect::Bash {
		return Ok(None);
	}
	if let Some(s) = Special::of(name) {
		return Ok(Some(s));
	}
	if !state::may_be_nameref(&k.root, vp) {
		return Ok(None);
	}
	Ok(match state::deref(&k.root, store, vp, name)? {
		state::Deref::To { name: target, index: None } => Special::of(&target),
		_ => None,
	})
}

/// [`look`] of `name`, or of the variable a name reference `name` names
/// (`declare -n r=RANDOM; [[ -v r ]]`).
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn look_through(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	name: &[u8],
	site: Site,
) -> Result<(), StoreError> {
	match named(k, cx.store, vp, name)? {
		Some(s) => look(k, cx, vp, s.name(), site),
		None => Ok(()),
	}
}

/// bash makes the special variable a plain one before an element, a
/// compound or an array attribute reaches it (`convert_var_to_array` and
/// `convert_var_to_assoc` drop the value and assignment functions), after
/// `site`'s lookups (`None`: the caller made them): the array's element 0
/// is the last value and the variable integer. A readonly one is refused
/// before it is converted, so it stays special. A local or temporary of the
/// name is only that one's.
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn to_plain(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	name: &[u8],
	site: Option<Site>,
) -> Result<(), StoreError> {
	let Some(s) = visible(k, cx.store, vp, name)? else {
		return Ok(());
	};
	for _ in 0..site.map_or(0, Site::lookups) {
		lookup(k, cx, vp, s)?;
	}
	if state::global_in(cx.store, vp, name)?.is_some_and(|v| v.attrs.contains(Attrs::READONLY)) {
		return Ok(());
	}
	k.set_plain(cx.store, vp, s);
	Ok(())
}

/// A use of a special variable, by the number of lookups bash 5.3.20 makes
/// of it there ([`Site::lookups`]; measured with `RANDOM`, each lookup one
/// draw). Only the lookups whose draws show are listed: a `NAME=value`
/// reseeds over the ones before it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Site {
	/// `declare`, `typeset`, `export`, `readonly` or `export -n` of the
	/// name with no value and no attribute option, and `declare -p NAME`:
	/// `declare_internal`'s `find_variable`.
	Declare,
	/// `declare` or `typeset` with an attribute option or `-g`, or with a
	/// value (`NAME=v`, `NAME+=v`, which adds to the value after them).
	DeclareChange,
	/// `declare -n NAME` with no value: bash then refuses the value as a
	/// reference's target.
	DeclareNameref,
	/// `local`, or `declare` in a function without `-g`, with or without
	/// options and value: `make_local_variable` and its callers, before the
	/// local exists.
	Local,
	/// The same in a function through a name reference that is not the
	/// function's own (a global one, or a caller's): the new local, of the
	/// reference's name, shadows it (`local r` with a global
	/// `declare -n r=RANDOM`).
	LocalShadow,
	/// In a function, `local -n NAME`, or `local +n NAME` with no value,
	/// through a name reference: the function's own, or another one with a
	/// value for the new local reference.
	LocalNameref,
	/// `export` or `readonly` with a value, after the assignment
	/// (`set_or_show_attributes`).
	ExportAfter,
	/// `declare 'NAME[i]=v'`, before the array conversion.
	DeclareElement,
	/// `NAME[i]=v`, `read 'NAME[i]'`, `printf -v 'NAME[i]'` and
	/// `${NAME[i]:=v}`'s assignment, before the conversion.
	Element,
	/// `NAME+=(…)`, `NAME=(…)`, `read -a NAME`, `mapfile NAME`, before the
	/// conversion.
	Compound,
	/// An arithmetic assignment to the name (`bind_int_variable`), before
	/// the value is assigned.
	ArithAssign,
	/// An arithmetic assignment to an element (`((NAME[i]=v))`,
	/// `$((NAME[i]=v))`), before the conversion.
	ArithElement,
	/// `let 'NAME[i]=v'`, before the conversion (bash 5.2.21 makes 3).
	LetElement,
	/// An arithmetic read of an element (`$((NAME[i]))`), before the read.
	ArithElementRead,
	/// A name reference resolved to the variable for an assignment
	/// (`declare -n r=RANDOM; r=7`, `r+=1`, `((r=7))`).
	NamerefAssign,
	/// A name reference to an element resolved for an assignment
	/// (`declare -n r='RANDOM[1]'; r=8`), before the element's own
	/// ([`Site::Element`]).
	NamerefElement,
	/// A temporary assignment `NAME=v cmd` (`assign_in_env`) with no
	/// temporary of the name in scope yet.
	Temp,
	/// `for NAME in …`, before each value.
	For,
	/// `unset NAME` and `unset 'NAME[i]'`.
	Unset,
	/// `test -v NAME`, `test -v 'NAME[i]'`, and each of the two lookups of
	/// `[[ -v NAME[i] ]]`: the name as written, then the expanded operand.
	Test,
	/// `${!NAME}`, after the value, and `${!r}` of a name reference `r` to
	/// the variable.
	Indirect,
	/// `${!NAME[@]}` and `${!NAME[*]}`: the keys (`0`).
	Keys,
	/// A parameter expansion before the value is read ([`Expansion`]).
	ExpandBefore(Expansion),
	/// A parameter expansion after the value is read ([`Expansion`]).
	ExpandAfter(Expansion),
}

impl Site {
	/// How many times bash 5.3.20 looks the variable up at this site.
	pub const fn lookups(self) -> u8 {
		match self {
			Self::Declare
			| Self::ExportAfter
			| Self::DeclareElement
			| Self::Compound
			| Self::ArithAssign
			| Self::ArithElementRead
			| Self::Temp
			| Self::For
			| Self::Unset
			| Self::Test
			| Self::Indirect
			| Self::Keys
			| Self::NamerefElement => 1,
			Self::DeclareChange | Self::Element | Self::NamerefAssign | Self::LocalNameref => 2,
			Self::DeclareNameref | Self::ArithElement | Self::LocalShadow => 3,
			Self::Local | Self::LetElement => 4,
			Self::ExpandBefore(e) => EXPANSION[e.sub as usize][e.op as usize].0,
			Self::ExpandAfter(e) => EXPANSION[e.sub as usize][e.op as usize].1,
		}
	}
}

/// A parameter expansion of a special variable, by its subscript and its
/// operator, for [`Site::ExpandBefore`] and [`Site::ExpandAfter`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Expansion {
	pub sub: Sub,
	pub op:  Op,
}

/// The subscript of an expansion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sub {
	/// `${NAME…}`.
	None,
	/// `${NAME[0]…}`: the value's element.
	Zero,
	/// `${NAME[i]…}` with `i` another index: no element.
	Other,
	/// `${NAME[@]…}`, `${NAME[*]…}`.
	All,
}

/// The operator of an expansion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
	/// None, or `-`, `=`, `?`, `+` (with or without `:`).
	Value,
	/// A substring, pattern removal, replacement, case change, or a
	/// transform other than `@A` and `@a`.
	Operator,
	/// `@A`, `@a`.
	Attrs,
	/// `${#…}`.
	Length,
}

/// (before, after) the value is read, by [`Sub`] then [`Op`]; the read is
/// one lookup more. Measured with `RANDOM=5; x=${RANDOM…}; echo $RANDOM`:
/// `${RANDOM:0}` is the first value and draws 3, `${RANDOM[0]:0}` the
/// fourth and draws 4, `${RANDOM[@]:0}` the second and draws 3.
const EXPANSION: [[(u8, u8); 4]; 4] = [
	// Value   Operator  Attrs   Length
	[(0, 0), (0, 2), (0, 2), (0, 0)], // None
	[(1, 0), (3, 0), (3, 0), (0, 0)], // Zero
	[(1, 0), (1, 0), (3, 0), (0, 0)], // Other
	[(1, 0), (1, 1), (1, 1), (0, 0)], // All
];

/// bash's dynamic variables that `${!prefix*}`, `${!prefix@}` and `compgen
/// -v` list (bash 5.3.20's `initialize_dynamic_variables`), that this shell
/// computes on use: `FUNCNAME` only in a function, `PIPESTATUS` only once a
/// command's status is recorded (bash makes it then: `set_pipestatus_array`),
/// `RANDOM` and `SECONDS` not once plain (a plain one is a variable, listed
/// as such).
pub const LISTED: &[&[u8]] = &[
	b"BASHPID",
	b"BASH_ALIASES",
	b"BASH_ARGC",
	b"BASH_ARGV",
	b"BASH_CMDS",
	b"BASH_COMMAND",
	b"BASH_LINENO",
	b"BASH_SOURCE",
	b"BASH_SUBSHELL",
	b"DIRSTACK",
	b"EPOCHREALTIME",
	b"EPOCHSECONDS",
	b"FUNCNAME",
	b"LINENO",
	b"PIPESTATUS",
	b"RANDOM",
	b"SECONDS",
	b"SRANDOM",
];

/// `names` (a variable listing, sorted) with [`LISTED`]'s names `vp`'s bash
/// code sees added, in order, each once.
///
/// # Errors
/// [`StoreError`] when the store cannot be read.
pub fn with_listed(
	k: &Kernel,
	store: &mut dyn StateStore,
	vp: &Vproc,
	names: &mut Vec<BString>,
) -> Result<(), StoreError> {
	if vp.mode.dialect() != Dialect::Bash {
		return Ok(());
	}
	let in_function = state::in_function(&k.root, store, vp)?;
	let before = names.len();
	for &name in LISTED {
		let shown = match Special::of(name) {
			Some(s) => !k.plain(vp, s),
			None => match name {
				b"FUNCNAME" => in_function,
				b"PIPESTATUS" => !vp.pipestatus.is_empty(),
				_ => true,
			},
		};
		if shown {
			names.push(BString::from(name));
		}
	}
	if names.len() > before {
		names.sort_unstable();
		names.dedup();
	}
	Ok(())
}
