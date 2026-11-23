// The signal probe of tests/process_signals.rs (`sigign_probe`): prints the signals this program
// started with ignored and exits 0. It reads them before any C library runs, with the raw
// rt_sigaction system call (glibc's sigaction refuses 32 and 33, its own signals), so it reads them
// where /proc/PID/status has no SigIgn line (gVisor). Linux x86_64, static, no libc.
// Build: cc -O2 -static -nostdlib -ffreestanding -fno-stack-protector -o sigign sigign.c
// Output: "SIGIGN <label> ign=<n,...>", or "ign=none" (label = argv[1]).
typedef unsigned long u64;

static long sys(long n, long a, long b, long c, long d) {
	long ret;
	register long r10 __asm__("r10") = d;
	__asm__ volatile("syscall" : "=a"(ret) : "a"(n), "D"(a), "S"(b), "d"(c), "r"(r10) : "rcx", "r11", "memory");
	return ret;
}

struct kernel_sigaction {
	void *handler;
	u64 flags;
	void *restorer;
	u64 mask;
};

static char out[512];
static int len;

static void put(const char *s) {
	while (*s && len < (int)sizeof out - 1) out[len++] = *s++;
}

static void put_num(int n) {
	char digits[8];
	int i = 0;
	do {
		digits[i++] = (char)('0' + n % 10);
		n /= 10;
	} while (n);
	while (i) out[len++] = digits[--i];
}

__attribute__((noreturn, used)) void start_c(long *sp) {
	int argc = (int)sp[0];
	char **argv = (char **)(sp + 1);
	put("SIGIGN ");
	put(argc > 1 ? argv[1] : "?");
	put(" ign=");
	int first = 1;
	for (int sig = 1; sig <= 64; sig++) {
		struct kernel_sigaction old;
		if (sys(13 /* rt_sigaction */, sig, 0, (long)&old, 8) != 0) continue;
		if (old.handler == (void *)1 /* SIG_IGN */) {
			if (!first) put(",");
			put_num(sig);
			first = 0;
		}
	}
	if (first) put("none");
	put("\n");
	sys(1 /* write */, 1, (long)out, len, 0);
	sys(60 /* exit */, 0, 0, 0, 0);
	__builtin_unreachable();
}

__asm__(".global _start\n_start:\n\tmov %rsp, %rdi\n\tand $-16, %rsp\n\tcall start_c\n");
