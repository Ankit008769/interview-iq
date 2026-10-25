// iq-sandbox: runs one untrusted command for the InterviewIQ code runner.
//
//   iq-sandbox --dir DIR --cpu SECONDS [--as BYTES] --nproc N --fsize BYTES [--env KEY=VALUE]... -- COMMAND [ARGS...]
//
// Order matters: resource limits first, then drop to the unprivileged sandbox user (65534) and give up
// supplementary groups, then forbid gaining privileges again (no_new_privs), then install a seccomp filter.
// The filter refuses network sockets (only Unix sockets are allowed), so code cannot reach the internet or
// the cloud metadata server, and refuses syscalls that widen the attack surface: ptrace, namespaces, mounts,
// keyrings, BPF, perf events, io_uring (which can bypass socket filtering) and kernel module or reboot calls.
// The command starts with an empty environment apart from the variables given here.
#define _GNU_SOURCE
#include <errno.h>
#include <grp.h>
#include <sched.h>
#include <seccomp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <unistd.h>

#define SANDBOX_ID 65534
#define MAX_ENV 32

static void die(const char *what) { fprintf(stderr, "iq-sandbox: %s: %s\n", what, strerror(errno)); _exit(125); }
static void limit(int resource, rlim_t soft, rlim_t hard, const char *name) {
  struct rlimit r = { soft, hard };
  if (setrlimit(resource, &r) != 0) die(name);
}
static rlim_t number(const char *value, const char *name) {
  char *end = NULL;
  errno = 0;
  unsigned long long n = strtoull(value, &end, 10);
  if (errno || !end || *end) { fprintf(stderr, "iq-sandbox: invalid %s\n", name); _exit(125); }
  return (rlim_t)n;
}

static void filter(void) {
  scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
  if (!ctx) die("seccomp_init");
  // Only AF_UNIX sockets: runtimes use them internally; every network family is refused.
  if (seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EACCES), SCMP_SYS(socket), 1, SCMP_A0(SCMP_CMP_NE, AF_UNIX)) != 0) die("seccomp socket");
  if (seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EACCES), SCMP_SYS(socketpair), 1, SCMP_A0(SCMP_CMP_NE, AF_UNIX)) != 0) die("seccomp socketpair");
  // New namespaces would give a process root inside them, so clone with any namespace flag is refused.
  // clone3 passes its flags in memory, which seccomp cannot inspect: it reports ENOSYS and the C library
  // falls back to clone.
  const unsigned long flags[] = { CLONE_NEWUSER, CLONE_NEWNET, CLONE_NEWNS, CLONE_NEWPID, CLONE_NEWIPC, CLONE_NEWUTS, CLONE_NEWCGROUP };
  for (size_t i = 0; i < sizeof flags / sizeof flags[0]; i++) {
    if (seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(clone), 1, SCMP_A0(SCMP_CMP_MASKED_EQ, flags[i], flags[i])) != 0) die("seccomp clone");
  }
  if (seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(clone3), 0) != 0) die("seccomp clone3");
  const int refused[] = {
    SCMP_SYS(ptrace), SCMP_SYS(process_vm_readv), SCMP_SYS(process_vm_writev), SCMP_SYS(unshare), SCMP_SYS(setns),
    SCMP_SYS(mount), SCMP_SYS(umount2), SCMP_SYS(pivot_root), SCMP_SYS(chroot), SCMP_SYS(keyctl), SCMP_SYS(add_key),
    SCMP_SYS(request_key), SCMP_SYS(bpf), SCMP_SYS(perf_event_open), SCMP_SYS(io_uring_setup), SCMP_SYS(io_uring_enter),
    SCMP_SYS(io_uring_register), SCMP_SYS(userfaultfd), SCMP_SYS(kexec_load), SCMP_SYS(init_module), SCMP_SYS(finit_module),
    SCMP_SYS(delete_module), SCMP_SYS(reboot), SCMP_SYS(swapon), SCMP_SYS(swapoff), SCMP_SYS(acct), SCMP_SYS(quotactl),
    SCMP_SYS(open_by_handle_at), SCMP_SYS(name_to_handle_at), SCMP_SYS(personality), SCMP_SYS(syslog),
  };
  for (size_t i = 0; i < sizeof refused / sizeof refused[0]; i++) {
    if (seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), refused[i], 0) != 0) die("seccomp rule");
  }
  if (seccomp_load(ctx) != 0) die("seccomp_load");
  seccomp_release(ctx);
}

int main(int argc, char **argv) {
  const char *dir = NULL;
  rlim_t cpu = 0, as = 0, nproc = 0, fsize = 0;
  char *env[MAX_ENV + 1];
  int envc = 0, i = 1;
  for (; i < argc; i++) {
    if (!strcmp(argv[i], "--")) { i++; break; }
    if (i + 1 >= argc) { fprintf(stderr, "iq-sandbox: missing value for %s\n", argv[i]); return 125; }
    if (!strcmp(argv[i], "--dir")) dir = argv[++i];
    else if (!strcmp(argv[i], "--cpu")) cpu = number(argv[++i], "cpu");
    else if (!strcmp(argv[i], "--as")) as = number(argv[++i], "as");
    else if (!strcmp(argv[i], "--nproc")) nproc = number(argv[++i], "nproc");
    else if (!strcmp(argv[i], "--fsize")) fsize = number(argv[++i], "fsize");
    else if (!strcmp(argv[i], "--env")) { if (envc >= MAX_ENV || !strchr(argv[i + 1], '=')) { fprintf(stderr, "iq-sandbox: bad env\n"); return 125; } env[envc++] = argv[++i]; }
    else { fprintf(stderr, "iq-sandbox: unknown option %s\n", argv[i]); return 125; }
  }
  if (!dir || !cpu || !nproc || !fsize || i >= argc) { fprintf(stderr, "iq-sandbox: --dir, --cpu, --nproc, --fsize and a command are required\n"); return 125; }
  env[envc] = NULL;

  limit(RLIMIT_CPU, cpu, cpu + 1, "RLIMIT_CPU");
  if (as) limit(RLIMIT_AS, as, as, "RLIMIT_AS");
  limit(RLIMIT_NPROC, nproc, nproc, "RLIMIT_NPROC");
  limit(RLIMIT_FSIZE, fsize, fsize, "RLIMIT_FSIZE");
  limit(RLIMIT_NOFILE, 128, 128, "RLIMIT_NOFILE");
  limit(RLIMIT_CORE, 0, 0, "RLIMIT_CORE");
  limit(RLIMIT_STACK, 64UL << 20, 64UL << 20, "RLIMIT_STACK");
  limit(RLIMIT_MEMLOCK, 0, 0, "RLIMIT_MEMLOCK");

  if (chdir(dir) != 0) die("chdir");
  if (getuid() == 0) {
    if (setgroups(0, NULL) != 0) die("setgroups");
    if (setresgid(SANDBOX_ID, SANDBOX_ID, SANDBOX_ID) != 0) die("setresgid");
    if (setresuid(SANDBOX_ID, SANDBOX_ID, SANDBOX_ID) != 0) die("setresuid");
  }
  if (getuid() != SANDBOX_ID || geteuid() != SANDBOX_ID || getgid() != SANDBOX_ID) { fprintf(stderr, "iq-sandbox: must start as root or the sandbox user\n"); return 125; }
  if (setresuid(0, 0, 0) == 0) { fprintf(stderr, "iq-sandbox: privileges were not dropped\n"); return 125; }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) die("no_new_privs");
  filter();
  execve(argv[i], &argv[i], env);
  die("execve");
  return 125;
}
