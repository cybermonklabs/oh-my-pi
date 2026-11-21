use std::{
	io,
	os::{
		linux::net::SocketAddrExt,
		unix::net::{SocketAddr, UnixDatagram},
	},
};

/// Whether an older omp build holds `path` by binding its abstract-socket
/// name. `connect(2)` resolves the name without binding it.
///
/// A policy can keep this process from Unix sockets: seccomp cannot read the
/// address `connect(2)` is given, so such a filter refuses `socket(2)` itself
/// (`EPERM`, or `EAFNOSUPPORT` from systemd's `RestrictAddressFamilies=`),
/// and an LSM can refuse the connect (`EACCES`/`EPERM`). The probe then
/// cannot tell, and reads the name as not bound so a sandboxed process can
/// still take leases. The limit: such a process does not see a lease an older
/// build holds outside the sandbox. An older build inside the same sandbox
/// could not have bound the name either.
pub fn is_bound(path: &str) -> io::Result<bool> {
	let address = SocketAddr::from_abstract_name(super::memory_lock_name(path).as_bytes())?;
	let socket = match UnixDatagram::unbound() {
		Ok(socket) => socket,
		Err(error) if refused_by_policy(&error) => return Ok(false),
		Err(error) => return Err(error),
	};
	match socket.connect_addr(&address) {
		Ok(()) => Ok(true),
		Err(error)
			if error.kind() == io::ErrorKind::ConnectionRefused || refused_by_policy(&error) =>
		{
			Ok(false)
		},
		Err(error) => Err(error),
	}
}

fn refused_by_policy(error: &io::Error) -> bool {
	matches!(error.raw_os_error(), Some(libc::EPERM | libc::EACCES | libc::EAFNOSUPPORT))
}
