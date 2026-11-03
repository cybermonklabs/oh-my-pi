//! glibc's fully buffered FILE accounting, used to locate the write that
//! raises SIGPIPE without delaying live output from an in-process utility.
//!
//! `_IO_new_file_xsputn` (fwrite/fputs/putc) writes whole blocks directly after
//! filling available space. `__printf_buffer_to_file` writes a full buffer
//! only when more output follows. A merely full buffer stays pending.

#![allow(dead_code, reason = "consumed by the feature-gated utility modules")]

const BUFSIZ: usize = 8192;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StdioCall {
	Write(usize),
	Printf(usize),
	Flush,
}

impl StdioCall {
	pub(crate) const fn len(self) -> usize {
		match self {
			Self::Write(n) | Self::Printf(n) => n,
			Self::Flush => 0,
		}
	}
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct StdioBuffer {
	allocated: bool,
	buffered: usize,
}

impl StdioBuffer {
	const ALLOCATED: usize = 1 << (usize::BITS - 1);

	pub(crate) fn apply(&mut self, cap: usize, call: StdioCall) -> usize {
		if cap == 0 {
			return call.len();
		}
		match call {
			StdioCall::Write(n) => self.sputn(cap, n),
			StdioCall::Printf(n) => self.printf(cap, n),
			StdioCall::Flush => std::mem::take(&mut self.buffered),
		}
	}

	pub(crate) const fn buffered(self) -> usize {
		self.buffered
	}

	fn sputn(&mut self, cap: usize, n: usize) -> usize {
		if n == 0 {
			return 0;
		}
		let room = if self.allocated { cap - self.buffered } else { 0 };
		let copied = room.min(n);
		self.buffered += copied;
		let rest = n - copied;
		if rest == 0 {
			return 0;
		}
		let flushed = std::mem::take(&mut self.buffered);
		self.allocated = true;
		let direct = rest - rest % cap;
		self.buffered = rest % cap;
		flushed + direct
	}

	fn printf(&mut self, cap: usize, n: usize) -> usize {
		if n == 0 {
			return 0;
		}
		self.allocated = true;
		let total = self.buffered + n;
		let written = (total - 1) / cap * cap;
		self.buffered = total - written;
		written
	}

	pub(crate) const fn pack(self) -> usize {
		self.buffered | if self.allocated { Self::ALLOCATED } else { 0 }
	}

	pub(crate) const fn unpack(word: usize) -> Self {
		Self { allocated: word & Self::ALLOCATED != 0, buffered: word & !Self::ALLOCATED }
	}
}

pub(crate) const fn buffer_size(blksize: u64) -> usize {
	if blksize > 0 && blksize < BUFSIZ as u64 { blksize as usize } else { BUFSIZ }
}

pub(crate) fn file_buffer_size(file: &pi_vfs::File) -> usize {
	#[cfg(unix)]
	if let Some(native) = file.native() {
		use std::os::unix::fs::MetadataExt;
		return native.metadata().map_or(BUFSIZ, |metadata| buffer_size(metadata.blksize()));
	}
	4096
}
