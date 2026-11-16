use std::{
	fs::File,
	io::{self, BufRead, BufReader},
	os::{
		linux::net::SocketAddrExt,
		unix::net::{SocketAddr, UnixDatagram},
	},
};

/// Linux lock held by an abstract Unix-domain socket binding.
pub struct PlatformFileLock {
	socket: Option<UnixDatagram>,
}

pub fn try_acquire(path: &str) -> io::Result<Option<PlatformFileLock>> {
	let name = super::memory_lock_name(path);
	let address = SocketAddr::from_abstract_name(name.as_bytes())?;
	match UnixDatagram::bind_addr(&address) {
		Ok(socket) => Ok(Some(PlatformFileLock { socket: Some(socket) })),
		Err(error) if error.kind() == io::ErrorKind::AddrInUse => Ok(None),
		Err(error) => Err(error),
	}
}

/// The kernel's table of the Unix sockets in the reader's network namespace,
/// the namespace that abstract names belong to.
const UNIX_SOCKET_TABLE: &str = "/proc/net/unix";
/// Fields before the path in a `/proc/net/unix` line: `Num`, `RefCount`,
/// `Protocol`, `Flags`, `Type`, `St`, `Inode`.
const FIELDS_BEFORE_PATH: usize = 7;

/// Looks the name up in `/proc/net/unix`, which lists a bound abstract name as
/// `@name`, whatever the socket's type, until its socket closes. Reading the
/// table creates, binds, and connects no socket, so a concurrent `try_acquire`
/// never meets this probe. Only where the table cannot be read does the probe
/// fall back to `connect(2)`, which resolves the name without binding it but
/// under gVisor can make a racing `try_acquire` find the name taken.
// One read of the table is not a snapshot: Linux serves it in pieces and drops
// its locks between them, so a socket that closes between two pieces can make
// that read skip the name. A read that misses the name is therefore taken
// again, and a lease held throughout reads as free only when both reads in a
// row skip it (never blocking a claim).
pub fn is_held(path: &str) -> io::Result<bool> {
	let name = super::memory_lock_name(path);
	unix_socket_table_lists(&name).or_else(|_| connect_probe(&name))
}

/// Whether `/proc/net/unix` lists the abstract `name`, reading the table a
/// second time only when the first read misses it.
fn unix_socket_table_lists(name: &str) -> io::Result<bool> {
	Ok(unix_socket_table_read_lists(name)? || unix_socket_table_read_lists(name)?)
}

/// Whether one read of `/proc/net/unix`, a line at a time, lists `name`.
fn unix_socket_table_read_lists(name: &str) -> io::Result<bool> {
	let mut table = BufReader::new(File::open(UNIX_SOCKET_TABLE)?);
	let mut line = Vec::new();
	while table.read_until(b'\n', &mut line)? != 0 {
		if abstract_name_listed(&line, name) {
			return Ok(true);
		}
		line.clear();
	}
	Ok(false)
}

/// Whether one `/proc/net/unix` line lists the abstract `name`: its path field,
/// everything after the seventh whitespace-separated field with the
/// surrounding whitespace removed, is exactly `@` followed by `name`. Works on
/// bytes because other sockets' paths need not be UTF-8. The header's path
/// field is `Path`, and an unbound socket's line has none.
fn abstract_name_listed(line: &[u8], name: &str) -> bool {
	let mut rest = line;
	for _ in 0..FIELDS_BEFORE_PATH {
		rest = rest.trim_ascii_start();
		let Some(end) = rest.iter().position(u8::is_ascii_whitespace) else {
			return false;
		};
		rest = &rest[end..];
	}
	rest.trim_ascii().strip_prefix(b"@") == Some(name.as_bytes())
}

/// Probes by `connect(2)`, for systems where `/proc/net/unix` cannot be read.
fn connect_probe(name: &str) -> io::Result<bool> {
	let address = SocketAddr::from_abstract_name(name.as_bytes())?;
	match UnixDatagram::unbound()?.connect_addr(&address) {
		Ok(()) => Ok(true),
		Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => Ok(false),
		Err(error) => Err(error),
	}
}

impl PlatformFileLock {
	#[allow(clippy::unnecessary_wraps, reason = "uniform cross-platform interface")]
	pub fn release(&mut self) -> io::Result<()> {
		drop(self.socket.take());
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::abstract_name_listed;

	const NAME: &str = "omp-file-lock-0123456789abcdef0123456789abcdef";
	/// A `/proc/net/unix` line up to its inode, as gVisor prints it.
	const SOCKET: &str = "0000000000000000: 00000001 00000000 00000000 0002 01  1006091";

	fn listed(line: &str) -> bool {
		abstract_name_listed(line.as_bytes(), NAME)
	}

	// A line misread as ours makes `omp session lease` report a free session as
	// running; ours misread as another's reports a running session as free.
	#[test]
	fn socket_table_line_lists_only_the_exact_abstract_name() {
		assert!(listed(&format!("{SOCKET} @{NAME}\n")));
		// A longer name that starts with ours.
		assert!(!listed(&format!("{SOCKET} @{NAME}0\n")));
		// Our name followed by more text.
		assert!(!listed(&format!("{SOCKET} @{NAME} more\n")));
		// A filesystem path whose last word is our name.
		assert!(!listed(&format!("{SOCKET} /run/a @{NAME}\n")));
		// The header alone.
		assert!(!listed("Num       RefCount Protocol Flags    Type St Inode Path\n"));
		// An unbound socket: no path field.
		assert!(!listed(&format!("{SOCKET}\n")));
	}
}
