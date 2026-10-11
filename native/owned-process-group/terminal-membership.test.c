#define proc_listpids fixture_proc_listpids
#define proc_pidinfo fixture_proc_pidinfo
#define main observer_cli_main
#include "darwin.c"
#undef main
#undef proc_pidinfo
#undef proc_listpids

static const char *scenario;

int fixture_proc_listpids(uint32_t type, uint32_t typeinfo, void *buffer, int buffersize) {
  (void)type;
  (void)typeinfo;
  const pid_t pids[] = {101, 202};
  const int bytes = (int)sizeof(pids);
  if (buffersize < bytes) {
    errno = EINVAL;
    return -1;
  }
  memcpy(buffer, pids, sizeof(pids));
  return bytes;
}

int fixture_proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize) {
  (void)flavor;
  (void)arg;
  if (buffersize < (int)sizeof(struct proc_bsdinfo)) {
    errno = EINVAL;
    return 0;
  }
  if (pid == 202 && strcmp(scenario, "gone") == 0) {
    errno = ESRCH;
    return 0;
  }

  struct proc_bsdinfo *info = buffer;
  memset(info, 0, sizeof(*info));
  info->pbi_pid = (uint32_t)pid;
  info->pbi_pgid = (uint32_t)(pid == 202 && strcmp(scenario, "moved") == 0 ? 202 : 101);
  info->pbi_status = pid == 202 && strcmp(scenario, "live") == 0 ? SRUN : SZOMB;
  info->pbi_start_tvsec = 1;
  return (int)sizeof(*info);
}

int main(int argc, char **argv) {
  if (argc != 2) return 64;
  scenario = argv[1];

  struct proc_bsdinfo previous = {0};
  previous.pbi_pid = 101;
  previous.pbi_pgid = 101;
  previous.pbi_status = SZOMB;
  previous.pbi_start_tvsec = 1;
  struct proc_bsdinfo leader = {0};
  int has_leader = 0;

  confirm_terminal_membership(101, 101, &previous, 1, &has_leader, &leader);
  return has_leader && leader.pbi_status == SZOMB ? 0 : 65;
}
